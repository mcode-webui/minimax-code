// The frame projector moved to the neutral Agent-turn seam; this module keeps
// the Mini App import path and its named contract stable.
export {
  createFrameProjector,
  type AgentTurnFrameProjector as MiniAppAgentFrameProjector,
} from '../../agent-turn/session-frame-projection.js';
