// The name this machine gives the gateway and shows in the panel.
//
// Composition and the release-file choice are pure so they can be pinned here;
// `remoteControlDeviceName()` itself only supplies this machine's two halves.
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  composeDeviceName,
  distributionNameFromOsRelease,
  operatingSystemName,
  remoteControlDeviceName,
} from "../../src/runtime/remote-control/device-name.js";

test("设备名是 主机名-系统名.WEBUI", () => {
  assert.equal(composeDeviceName("fectivnfy-GTi", "Ubuntu"), "fectivnfy-GTi-Ubuntu.WEBUI");
  assert.equal(composeDeviceName("fectivnfy-GTi", "Linux"), "fectivnfy-GTi-Linux.WEBUI");
  assert.equal(composeDeviceName("macbook", "macOS"), "macbook-macOS.WEBUI");
  assert.equal(composeDeviceName("desk", "Windows"), "desk-Windows.WEBUI");
});

test("没有主机名时退回 this computer，没有系统名时只留主机名，后缀照旧", () => {
  assert.equal(composeDeviceName("", "Ubuntu"), "this computer-Ubuntu.WEBUI");
  assert.equal(composeDeviceName("   ", undefined), "this computer.WEBUI");
  assert.equal(composeDeviceName("fectivnfy-GTi", undefined), "fectivnfy-GTi.WEBUI");
});

test("主机名已经带系统名时不重复拼一次，也没有第二个后缀", () => {
  assert.equal(
    composeDeviceName("fectivnfy-GTi-Ubuntu", "Ubuntu"),
    "fectivnfy-GTi-Ubuntu.WEBUI",
  );
  assert.equal(composeDeviceName("fectivnfy-GTi-ubuntu", "Ubuntu"), "fectivnfy-GTi-ubuntu.WEBUI");
  assert.equal(
    composeDeviceName("fectivnfy-GTi-Ubuntu.WEBUI", "Ubuntu"),
    "fectivnfy-GTi-Ubuntu.WEBUI",
  );
  // 后缀大小写不同也算已带后缀，规范化成 `.WEBUI` 而不是再加一个。
  assert.equal(composeDeviceName("box.webui", undefined), "box.WEBUI");
});

test("系统名里的空格和引号不会进到设备名里", () => {
  assert.equal(composeDeviceName("box", "Debian GNU/Linux"), "box-Debian-GNU-Linux.WEBUI");
  assert.equal(composeDeviceName("box", "  "), "box.WEBUI");
});

test("Linux 发行版名取 NAME 的第一个词，只有通用 Linux 时才用 ID", () => {
  const cases: [Map<string, string>, string | undefined][] = [
    [new Map([["NAME", "Ubuntu"], ["ID", "ubuntu"]]), "Ubuntu"],
    [new Map([["NAME", "Fedora Linux"], ["ID", "fedora"]]), "Fedora"],
    [new Map([["NAME", "Debian GNU/Linux"], ["ID", "debian"]]), "Debian"],
    [new Map([["NAME", "Arch Linux"], ["ID", "arch"]]), "Arch"],
    [new Map([["NAME", "openSUSE Leap"], ["ID", "opensuse-leap"]]), "openSUSE"],
    // `Linux Mint` 的首词是通用词，只有 ID 能区分它。
    [new Map([["NAME", "Linux Mint"], ["ID", "linuxmint"]]), "Linuxmint"],
    [new Map([["ID", "alpine"]]), "Alpine"],
    [new Map([["PRETTY_NAME", "Whatever"]]), undefined],
  ];
  for (const [fields, expected] of cases) {
    assert.equal(distributionNameFromOsRelease(fields), expected, JSON.stringify([...fields]));
  }
});

test("本机上拼出来的是 主机名-系统名.WEBUI", () => {
  const name = remoteControlDeviceName();
  const os = operatingSystemName();
  assert.ok(name.length > 0);
  assert.ok(name.endsWith(".WEBUI"), `${name} 应以 .WEBUI 结尾`);
  if (os !== undefined) {
    assert.ok(
      name.toLowerCase().endsWith(`-${os.toLowerCase()}.webui`),
      `${name} 应以 -${os}.WEBUI 结尾`,
    );
  }
});
