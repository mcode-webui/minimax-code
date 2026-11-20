// Derived from AI Node Canvas 1.22.9, Copyright (c) 2026 antianqi. MIT; see LICENSE.
export const BUILTIN_TEMPLATES = [
  {
    "id": "image-mimic",
    "title": "图片复刻",
    "description": "放一张图进去，先把它的提示词反推出来，再照着重新生成一张 1:1 的图。",
    "group": "从素材出发",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "参考图",
          "prompt": "",
          "kind": "image",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "反推提示词",
          "prompt": "写出一段能复刻这张图的提示词：画面主体、动作与表情、镜头与构图、光线与色彩、材质与风格",
          "mode": "describe",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "image",
          "title": "复刻",
          "prompt": "",
          "mode": "text2image",
          "kind": "image",
          "model": "matrix-image",
          "ratio": "1:1",
          "resolution": "4K",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@2"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@2",
          "to": "@3"
        }
      }
    ]
  },
  {
    "id": "video-mimic",
    "title": "视频模仿",
    "description": "放一段视频进去，先把它的提示词反推出来，再按 H3 的结构写成提示词，最后照着生成一条视频。",
    "group": "从素材出发",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "参考视频",
          "prompt": "",
          "kind": "video",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "反推提示词",
          "prompt": "写出能复刻这条视频的提示词：镜头顺序与运镜、主体动作、环境与光线、节奏与时长",
          "mode": "video2text",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "文本",
          "prompt": "",
          "mode": "prompt",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "h3-t2va"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "video",
          "title": "视频",
          "prompt": "",
          "mode": "text2video",
          "kind": "video",
          "model": "MiniMax-H3",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@2"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@2",
          "to": "@3"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@3",
          "to": "@4"
        }
      }
    ]
  },
  {
    "id": "h3-t2va",
    "title": "H3 · 文生视频",
    "description": "让提示词增强按 H3 的 T2VA 结构写好，再出一条 16:9、768P 的视频。",
    "group": "H3",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "H3 提示词",
          "prompt": "一只粉色小章鱼戴着贝雷帽趴在画布前画画，镜头缓缓推进，环境安静",
          "mode": "prompt",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "h3-t2va"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "video",
          "title": "成片",
          "prompt": "",
          "mode": "text2video",
          "kind": "video",
          "model": "MiniMax-H3",
          "ratio": "16:9",
          "resolution": "768P",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@2"
        }
      }
    ]
  },
  {
    "id": "h3-i2va",
    "title": "H3 · 首帧图生视频",
    "description": "一张图当首帧，提示词按 H3 的 I2VA 结构写。",
    "group": "H3",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "首帧图",
          "prompt": "",
          "kind": "image",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "H3 提示词",
          "prompt": "参考图里的主体缓缓转动，镜头轻轻向前推进，背景光晕缓慢流动",
          "mode": "prompt",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "h3-i2va"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "video",
          "title": "成片",
          "prompt": "",
          "mode": "imagekey2video",
          "kind": "video",
          "model": "MiniMax-H3",
          "ratio": "16:9",
          "resolution": "768P",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@3"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@2",
          "to": "@3"
        }
      }
    ]
  },
  {
    "id": "h3-fl2va",
    "title": "H3 · 首尾帧图生视频",
    "description": "首帧和尾帧各一张，提示词按 H3 的 FL2VA 结构写。",
    "group": "H3",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "首帧图",
          "prompt": "",
          "kind": "image",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "尾帧图",
          "prompt": "",
          "kind": "image",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "H3 提示词",
          "prompt": "从首帧到尾帧，主体缓缓转身，镜头横向平移，光线由冷转暖",
          "mode": "prompt",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "h3-fl2va"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "video",
          "title": "成片",
          "prompt": "",
          "mode": "imagefl2video",
          "kind": "video",
          "model": "MiniMax-H3",
          "ratio": "16:9",
          "resolution": "768P",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@4"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@2",
          "to": "@4"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@3",
          "to": "@4"
        }
      }
    ]
  },
  {
    "id": "h3-l2va",
    "title": "H3 · 末帧图生视频",
    "description": "一张图当尾帧，提示词按 H3 的 L2VA 结构写。",
    "group": "H3",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "尾帧图",
          "prompt": "",
          "kind": "image",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "H3 提示词",
          "prompt": "镜头缓缓拉远，主体在画面中央停住，背景渐渐暗下来",
          "mode": "prompt",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "h3-l2va"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "video",
          "title": "成片",
          "prompt": "",
          "mode": "imageend2video",
          "kind": "video",
          "model": "MiniMax-H3",
          "ratio": "16:9",
          "resolution": "768P",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@3"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@2",
          "to": "@3"
        }
      }
    ]
  },
  {
    "id": "h3-reference",
    "title": "H3 · 全参考生视频",
    "description": "图、视频、音频都能当参考，空着的就是不带的；提示词按 H3 的全参考格式写。",
    "group": "H3",
    "actions": [
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "参考图",
          "prompt": "",
          "kind": "image",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "参考视频",
          "prompt": "",
          "kind": "video",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "input",
          "title": "参考音频",
          "prompt": "",
          "kind": "audio",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "text",
          "title": "H3 提示词",
          "prompt": "参考里的主体在原地做一个轻微的动作，镜头保持不动",
          "mode": "prompt",
          "kind": "text",
          "model": "default",
          "count": 1,
          "templateId": "h3-reference"
        }
      },
      {
        "type": "add_node",
        "args": {
          "type": "video",
          "title": "成片",
          "prompt": "",
          "mode": "image2video",
          "kind": "video",
          "model": "MiniMax-H3",
          "ratio": "16:9",
          "resolution": "768P",
          "count": 1,
          "templateId": "custom"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@1",
          "to": "@5"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@2",
          "to": "@5"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@3",
          "to": "@5"
        }
      },
      {
        "type": "connect",
        "args": {
          "from": "@4",
          "to": "@5"
        }
      }
    ]
  }
];
