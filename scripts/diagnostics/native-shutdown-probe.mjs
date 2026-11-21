import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Run from a disposable clean checkout; anchors match production package resolution
// under pnpm without depending on a hoisted root native addon.
const fromDatabasePackage = createRequire(new URL('../../packages/local-runtime-v2/package.json', import.meta.url));
const [mode, directory] = process.argv.slice(2);
const mark = (phase, fields={}) => writeSync(2, JSON.stringify({ phase, ms: Math.round(performance.now()), ...fields })+'\n');
function launch(lane, directory) {
  const child = fork(fileURLToPath(import.meta.url), [lane, directory], {
    execArgv: process.execArgv,
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exit = once(child, 'exit');
  return { child, exit };
}
async function stop(ref) {
  if (!ref || ref.child.exitCode !== null || ref.child.signalCode !== null) return;
  ref.child.kill('SIGKILL');
  let timer;
  try {
    await Promise.race([ref.exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('probe child did not terminate')), 2000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
if (!directory) {
  if (!['wal','wal-reader','pty','negative-watchdog'].includes(mode)) throw Error('unknown probe lane');
  const temp = await mkdtemp(path.join(realpathSync.native(tmpdir()), 'mcode-shutdown-probe-'));
  const worker = launch(mode,temp);
  let watchdog;
  let reader;
  let timedOut = false;
  let negativeStageConfirmed = false;
  function arm(ms) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      timedOut = true;
      mark('external-watchdog', {mode, negativeStageConfirmed});
      // Object handle refers to the specific isolated probe children; never
      // enumerate or match arbitrary system processes or command names.
      worker.child.kill('SIGKILL');
      reader?.child.kill('SIGKILL');
    },ms);
  }
  arm(25_000);
  worker.child.on('message', (message) => {
    if (mode === 'negative-watchdog' && message === 'before-deliberate-block') {
      negativeStageConfirmed = true;
      arm(250);
    } else if (mode === 'wal-reader' && message === 'open-reader') {
      reader = launch('reader', temp);
      reader.child.on('message', (received) => {
        if (received === 'reader-held' && worker.child.connected) worker.child.send('reader-held');
      });
      void reader.exit.then(([code, signal]) => {
        if ((code !== 0 || signal) && !timedOut && worker.child.connected) {
          worker.child.send('reader-failed');
        }
      });
    } else if (message === 'release-reader' && reader?.child.connected) {
      reader.child.send('release');
    }
  });
  try {
    const [code,signal] = await worker.exit;
    if (mode === 'negative-watchdog' && timedOut && negativeStageConfirmed && (code !== 0 || signal)) {
      mark('expected-watchdog-verdict-verified');
    } else if (timedOut || code !== 0 || signal || mode === 'negative-watchdog') {
      throw Error(`probe failed: ${code}/${signal}; watchdog=${timedOut}`);
    }
    if (reader) {
      const [readerCode, readerSignal] = await reader.exit;
      if (readerCode !== 0 || readerSignal) throw Error('independent reader did not close normally');
    }
  } finally {
    clearTimeout(watchdog);
    await Promise.allSettled([stop(worker), stop(reader)]).then((results) => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    await rm(temp,{recursive:true,force:true});
  }
} else if (mode === 'negative-watchdog') {
  mark('before-deliberate-block');
  await new Promise((resolve, reject) => process.send('before-deliberate-block', (error) => error ? reject(error) : resolve()));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else if (mode.startsWith('wal') || mode === 'reader') {
  const Database = fromDatabasePackage('better-sqlite3');
  const dbPath = path.join(directory,'runtime.db');
  const open = () => {
    const db = new Database(dbPath);
    db.exec('PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON');
    return db;
  };
  if (mode === 'reader') {
    const db = open();
    db.exec('BEGIN');
    const readCount = () => db.prepare('SELECT COUNT(*) c FROM work').get().c;
    if (readCount() !== 1) throw Error('independent reader did not establish snapshot');
    mark('independent-reader-snapshot-held');
    const release = once(process, 'message');
    process.send('reader-held');
    if ((await release)[0] !== 'release' || readCount() !== 1) throw Error('reader snapshot was not preserved');
    db.exec('ROLLBACK');
    db.close();
    mark('independent-reader-snapshot-released');
    process.disconnect();
  } else {
    const writer = open();
    writer.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE work(data BLOB); INSERT INTO work VALUES(zeroblob(4096))');
    if (mode === 'wal-reader') {
      const ready = once(process, 'message');
      process.send('open-reader');
      if ((await ready)[0] !== 'reader-held') throw Error('independent reader did not establish snapshot');
    }
    writer.exec('BEGIN; INSERT INTO work SELECT zeroblob(4096) FROM work; COMMIT;');
    mark('real-sqlite-close-entry',{readerHeld:mode==='wal-reader'});
    const start=performance.now();
    writer.close();
    mark('real-sqlite-close-return',{elapsedMs:Math.round(performance.now()-start)});
    const verify = new Database(dbPath,{readonly:true,fileMustExist:true});
    if (verify.pragma('integrity_check',{simple:true})!=='ok' || verify.prepare('SELECT COUNT(*) c FROM work').get().c!==2) throw Error('durability/integrity failed');
    verify.close();
    mark('integrity-and-durable-writes-confirmed');
    if (mode === 'wal-reader') {
      await new Promise((resolve, reject) => process.send('release-reader', (error) => error ? reject(error) : resolve()));
    }
    process.disconnect();
  }
} else {
  const {WebuiTerminalManager} = await import('../../packages/webui/src/runtime/terminal.ts');
  const {loadWebuiPty} = await import('../../packages/webui/src/runtime/native-pty.ts');
  const native=loadWebuiPty();
  const exits=[];
  let count=0;
  const shell=process.platform==='win32'?'powershell.exe':'/bin/sh';
  process.env.SHELL=shell;
  const manager=new WebuiTerminalManager(()=>({spawn(name,args,opts){
    const pty=native.spawn(name,args,opts);
    const index=exits.length;
    exits.push(new Promise(resolve=>pty.onExit(({exitCode,signal})=>{count++;mark('real-pty-exit',{index,exitCode,signal,count});resolve();})));
    return pty;
  }}));
  const ids=Array.from({length:5},()=>manager.create(directory).terminalId);
  async function proveReady(id) {
    manager.write(id, process.platform==='win32'?"Write-Output ('PTYS_' + 'READY')\r":"printf 'PTYS_%s\\n' READY\r");
    const started=performance.now();
    while (!manager.list().find(p=>p.terminalId===id)?.output.includes('PTYS_READY')) {
      if (performance.now()-started>20_000) throw Error('real shell did not execute readiness probe');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  const first=ids[0];
  await proveReady(first);
  manager.dispose(first);
  manager.create(directory);
  manager.dispose(ids[1]);
  const last=manager.create(directory).terminalId;
  await proveReady(last);
  manager.dispose(last);
  if (exits.length!==7 || manager.list().length!==4) throw Error('wrong lifecycle roster');
  mark('manager-session-close-entry',{spawned:exits.length,alreadyExited:count});
  manager.disposeBySession();
  mark('manager-session-close-return',{alreadyExited:count});
  await Promise.all(exits);
  if (count!==7 || manager.list().length) throw Error('wrong native receipt');
  mark('all-real-exits-confirmed',{count});
  process.exit(0);
}
