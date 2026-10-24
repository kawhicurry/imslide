# imslide

**Agent 文字/语音工作台 + 多文稿管理 + 原生 Vue / Slidev 画布。**

前端保留文字指令、语音输入和工具执行状态。模型强制只调用工具，完成后调用 `finish`，不输出解释或完成总结。左侧支持文稿管理、预览、演示三种模式；文稿管理可通过界面或语音操作，页面内容通过 Agent 编辑。右侧语音、对话和草稿在模式切换时保持挂载。三模式导航栏隐藏，点击品牌可返回文稿库。画布、左侧页面列表与 Agent 共用一个当前页；选中已有页面后，后续指令就操作该页。

系统提示词统一在 [`prompt.ts`](./prompt.ts) 配置，包括幻灯片编辑 Agent、动态文稿上下文前缀和语音转写校准器。修改后重启服务；开发模式会自动重载。

Agent、语音处理和 API 位于 [`imslide.ts`](./imslide.ts)，文稿库位于 `src/deck-library.ts`。原有 `slides/slides.md` 登记为第一份文稿；文稿目录、每份文稿当前页和工作区模式持久化到源文件同目录的 `.imslide/library.json`，新文稿位于 `.imslide/decks/`。Slidev 只监听同目录派生入口 `.slides.active.md`，切换文稿不启动第二个编译器。没有页 ID 的旧 Markdown 会保留原件，并生成规范化副本作为第一份文稿。

## 启动工作台

需要 Node.js 22.12+。

```sh
npm install
cp .env.example .env
# 如需 Agent，填写 OPENAI_API_KEY；可选 OPENAI_MODEL、OPENAI_BASE_URL
npm run dev
```

打开 http://127.0.0.1:5173 。启动器先等待后端（3001）初始化文稿，再启动 Vue + Slidev 合并工作台（5173）。3030 保留为代理到同一应用的兼容入口，支持 HTTP 与 WebSocket；不再启动第二个 Slidev 编译服务。三个端口均保持原值并只监听本机。

如凭据已保存在私有配置，可只在 `.env` 中放引用，不复制密钥：

```dotenv
PRIVATE_LLM_CONFIG=~/.private/config.yaml
OPENAI_MODEL=qwen-flash
OPENAI_ENABLE_THINKING=false
```

服务端从 `agent.llm.api_key` 和 `agent.llm.base_url` 读取凭据与地址。显式 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 优先于私有配置；`OPENAI_ENABLE_THINKING=false` 为兼容服务请求加入非思考模式开关。不要将这些参数放入 `VITE_*`，也不要提交 `.env`。

不配置模型也能查看已有文稿。首次运行无文稿时，只创建一张空白页。已存在的文稿会保留。旧版 `.data/deck.json` 只用于一次性恢复匹配文稿的页标识、当前位置和版本；迁移后不再读写旧 JSON。备份时保留原 Markdown 和整个 `.imslide/` 目录；派生入口可由后端重建。

## 文稿与模式工具

语音工具触发全屏时若被浏览器的用户手势限制拦截，画布提供“点击进入全屏演示”入口；不会用普通放大布局冒充全屏。

首次进入管理页；新建、搜索、打开、重命名、复制、删除及回收站恢复均支持界面操作。删除不永久销毁文件。预览保留分页缩略图；演示调用浏览器 Fullscreen API，画布占满屏幕；右侧保持挂载，退出全屏后恢复可见，Esc 返回预览，末页翻页不创建新页。

所有文本和语音请求始终提供完整工具定义：`get_workspace`、`switch_mode`、`list_decks`、`create_deck`、`open_deck`、`rename_deck`、`duplicate_deck`、`delete_deck`、`restore_deck`，以及现有页面工具、`finish` 和 `apply_voice`。权限由执行时的后端模式控制：

- 管理文稿仅管理模式；`open_deck` 打开并进入预览。
- 页面修改及新增仅预览模式；读页及翻页允许预览、演示。
- 查询工作区、切模式和结束始终可用；语音批量计划逐步执行同样的权限检查。
- 不匹配返回 `TOOL_UNAVAILABLE_IN_MODE`、`currentMode` 和 `allowedModes`，不产生副作用。Agent 必须显式切模式。
- UI/API 切换模式或活动文稿会终止旧 Agent 任务，防止旧要求重新应用到另一份文稿；录音连接保留。

`GET /api/workspace` 返回 `{workspace, deck}`；`POST /api/workspace/action` 接受 `{action: {tool, ...参数}, context: {deckId, workspaceRevision}}`。`POST /api/view` 接受 `{pageId, deckId, workspaceRevision}`。过期版本返回 409 / `STALE_WORKSPACE`；SSE 的 `workspace` 事件同时携带工作区和当前文稿快照。文稿名称可重复，操作一律用列表返回的稳定 ID。

当前动态编译和文稿切换通过 `npm run dev` 的单个 Vite / Slidev 服务运行。`npm run build` 检查类型并导出构建时活动文稿的静态资源，不是动态多文稿服务的替代品。

## 作为单文件模块调用

`imslide.ts` 可以直接导入，不会自行启动 Web 服务。它依赖 `ai`、`@ai-sdk/openai`、`@slidev/parser`、`zod`、`express` 和 `dotenv`；单文件指业务能力集中在此文件，不是零依赖可执行文件。

```ts
import { ImSlide } from './imslide.ts';
import { createOpenAI } from '@ai-sdk/openai';

const slides = await ImSlide.open({
  file: './slides/slides.md',
  model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).chat('gpt-4.1-mini'),
  quietMs: 1200,
  onEvent(event) {
    // accepted / steering-applied / text / tool / tool-skipped / deck / done / error
    console.log(event);
  },
});

slides.steer('制作一页关于未来工作方式的封面', 'instruction-1');
// 可以在上一次仍生成时调用；同一个 run 内，在下一次模型推理前注入。
slides.steer('标题改为绿色，保留其余内容', 'instruction-2');
await slides.waitForIdle();

// 新增或翻页也通过 Agent，不提供宿主直接新增/编辑接口。
slides.steer('下一页，介绍产品优势', 'instruction-3');
await slides.waitForIdle();
console.log(slides.snapshot());
await slides.close();
```

`onEvent`/`subscribe` 提供实时事件；`text` 按片段输出，`deck` 表示一次页面写入已经完成。`steer()` 返回 `{runId, messageId, mode}`；运行中返回同一 `runId`，`mode` 为 `steer`，不是等待整轮完成再发起一个新对话。同一输入 `id` 在当前进程的最近 512 条记录内幂等；不同语句即使文本相同，也应使用不同 ID。

## 语音输入与外部识别接入

前端使用 AudioWorklet 连续采集 PCM，按 20ms 音量帧检测讲话，400ms 停顿确认一句；连续讲话以每 4 秒新增音频、前 2 秒重叠作为兜底。160ms 短停顿时可提前请求后端 ASR，400ms 确认后复用完全相同音频的结果，继续讲话时废弃旧预识别。预识别不会提前校准或执行。录音、识别与校准异步衔接，ASR 请求单路执行；前后端队列均有上限，前端过载会明确暂停录音，不静默丢弃音频。Agent 和所有模型推理均在后端。

识别片段按录音顺序通过 `/api/voice` 交给后端 Agent，同一轮推理完成校准、完整性判断和工具计划，不再请求独立校准模型。物理重叠窗口的可靠文字后缀/前缀被对齐为累计快照；无法可靠对齐时保留原文，由模型结合成功工具历史判断。默认 MOSS 模式将音频发送至配置的 SSH 主机，可显式选择本机 Whisper。界面转写保留识别原文；实际操作以 Agent 的结构化指令和工具结果为准。

点击停止会提交最后不足 4 秒的尾段并等待队列完成。失败片段提示错误，后续片段继续；校准失败的文字保留虚字且不执行。请求重试使用同一会话和片段编号，避免重复追加。原始转写、128 字上下文、校准追加内容及时间按会话记录在本机 `.data/transcripts/*.jsonl`（权限 600），不保存音频。服务重启后可从日志恢复合并上下文和去重结果。

本机 ASR 首次配置（Python 3.11+；可通过 `ASR_PYTHON` 指定解释器）：

```sh
python3 -m venv .data/asr-venv
.data/asr-venv/bin/pip install -r scripts/asr-requirements.txt
.data/asr-venv/bin/python -c "from faster_whisper.utils import download_model; download_model('base')"
# .env 中设置 ASR_PYTHON 为该 Python 的绝对路径，ASR_MODEL=base
```

Whisper 模式只加载本地模型缓存（也可把 `ASR_MODEL` 设为本机 CTranslate2 模型目录），不自动下载。依赖缺失会明确提示，文字输入仍可使用。`GET /api/asr/status` 预热识别服务，`POST /api/asr` 接受最长 24 秒的 16kHz 单声道 Float32 PCM，MOSS 返回文字，Whisper 返回识别词；响应的 `timing` 分别记录服务端排队、处理与总耗时。浏览器需要麦克风权限和 AudioWorklet 支持。

文字输入和已定稿的语音均可在 Agent 运行中继续发送，传输只等待接收确认，不等待上一轮完成，运行中进入同一个 run 的 steer 处理。工具执行与文稿更新通过 SSE 实时显示，模型不再发送文本回复。

也可以由外部调用方接自己的 ASR，将结果送给同一模块：

```ts
// text 是同一句话的累计识别快照，不是增量字符。utteranceId 在整句内保持不变。
slides.ingest({ type: 'transcript', utteranceId: 'speech-1', text: '标题改成', isFinal: false });
slides.ingest({ type: 'transcript', utteranceId: 'speech-1', text: '标题改成绿色', isFinal: false });
// ASR 确定整句结束，才注入 Agent。
slides.ingest({ type: 'transcript', utteranceId: 'speech-1', text: '标题改成绿色。', isFinal: true, endOfUtterance: true });
```

规则：

- `isFinal: false` 永远不注入 Agent，识别修订会替换草稿。
- `isFinal: true` 且 `endOfUtterance: true` 表示整句已确认，立即注入一次。
- 如果 ASR 没有明确的整句结束信号，`isFinal: true` 后使用 `quietMs` 稳定窗口（默认 1200ms）。窗口内任何新识别结果都会取消或重置计时；新 interim 会阻止此前已确认前缀被提前提交。
- 单独的结束信号可调用 `slides.endUtterance('speech-1')`。若最新文本仍为 interim，不提交半句；等待最终识别到达。
- 停止/关闭时不强行提交草稿。已提交的 `utteranceId` 重复回调不会再次注入；下一句话必须使用新 ID。

**steer 生效边界**：当前模型请求的上下文不能在半个 token 中原地替换。底层保留同一个处理 run 和完整工具历史，在下一步推理前按到达顺序注入已确认语句。新 steer 到达后，尚未提交的旧工具会被跳过；已经进入原子保存的修改会保留。新指令到达后的旧回复片段停止向外输出，后续继续流式输出新结果。即使旧模型正在输出无工具调用的最终回复，新句子也会接着在同一 run 内处理，不会丢在末尾。

## 本地接口

单独启动底层，无需前端：

```sh
npm run serve
```

读取接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/deck` | 当前文稿及 Agent 当前页快照 |
| `GET /api/events` | SSE 事件流，连接时先发送当前文稿快照 |
| `GET /api/status` | 是否配置模型、是否运行、steer 模式 |
| `GET /api/preview-health` | Slidev 渲染服务状态 |
| `POST /api/view` | 以 `{pageId, deckId, workspaceRevision}` 选择已有页，同步画布与 Agent 当前页 |

前端文字对话使用 `POST /api/chat`（`{message, id?, mode: "steer"}`），已定稿语音与外部调用使用 `POST /api/input`。两者均返回接收确认，Agent 回复和页面更新通过 `/api/events` 流式返回。文稿管理有独立接口，页面正文仍由 Agent 工具写入：

```sh
curl -X POST http://127.0.0.1:3001/api/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"instruction","id":"command-1","text":"下一页，介绍产品优势","mode":"steer"}'

curl -X POST http://127.0.0.1:3001/api/input \
  -H 'Content-Type: application/json' \
  -d '{"type":"transcript","utteranceId":"speech-2","text":"把标题放大一些。","isFinal":true,"endOfUtterance":true}'
```

响应 `202` 只表示接收，不代表执行成功。订阅事件流查看 `accepted → steering-applied → deck → done` 或 `error/input-failed`。语音 interim 响应为 `draft`，稳定窗口内为 `stabilizing`，整句提交为 `committed`。独立结束信号使用 `{"type":"utterance-end","utteranceId":"speech-2"}`。Agent 的 `/api/chat` 交互接口保留；手动编辑的 `/api/action` 已移除。

## 文件与渲染关系

```text
外部 ASR ── interim（仅保留草稿）
       └── final + 整句结束 / 稳定窗口
                         ↓
                    imslide.ts
                   steer Agent ← 外部文字指令
                         ↓
                  文稿库 / 独立 Markdown
                         ↓
                 Slidev 监听与热更新
                         ↓
                   前端只读画布 + Agent 对话面板
```

页正文使用标准 Slidev Markdown；`---` 分隔页面，frontmatter 中的 `imslide`、`imslideId`、`imslideTitle`、`imslideContentKey` 保存文稿信息及页面内容指纹。不再使用第二份 JSON 文稿。原子替换源文件防止读取到半写入状态。

当前页统一保存在 `deck.current`，前端没有第二套浏览游标。左侧或底部选择已有页面，通过 `POST /api/view` 提交稳定的 `pageId`、`deckId` 和 `workspaceRevision`；该接口只允许选择已有页，不能新增、删除或修改正文。随后发出的对话会等待选页确认，确保 Agent 操作的就是所选页面。运行中的旧工具若遇到页版本变化，会跳过并在新上下文中重新规划。

`slides/setup/root.ts` 是 Slidev 渲染适配器。画布按页面 ID 和文稿版本导航，Slidev 回报实际渲染的 ID、页码、总页数和版本；四项匹配后才显示预览。新增或删除页面后先等待热更新，防止新页路由尚未就绪时落回旧页。适配器只在嵌入预览中启用，校验父窗口来源。

单个页面正文禁止任何以 `---` 开头的行，包括 `----`：Slidev 会把它们识别为额外分页，需要横线时使用 `***`。每次保存还会使用官方 Slidev 解析器核对页面数量和 ID，确保应用一页严格对应 Slidev 一页。选页按钮在首尾禁用，不会自动创建页面。Slidev 内置编辑器也已关闭。

## 验证与边界

```sh
npm run build
npm test
```

测试使用临时文件和本地 OpenAI-compatible SSE 模型服务，覆盖真实 Vercel ToolLoopAgent 的工具调用、处理中 steer、旧工具跳过、纯文本回复尾部续接、语音去重、interim 阻止半句提交、整句稳定计时、前后翻页，以及仅凭 Markdown 恢复文稿（含备注和空白）。不使用真实模型密钥，也不覆盖本地文稿。

这是单用户、本机运行能力；最多 60 页，每页正文 24,000 字符，运行中最多等待 16 条 steer，每个 run 最多接收 64 条指令、执行 32 步或持续 120 秒。一个文稿同时只能由一个能力实例管理，不支持多进程并发写同一文件。对话和语音去重记录不跨进程保留；失败后的已保存内容不会回滚。

前端使用本机 Whisper 识别；核心文稿与 Agent 能力仍在 imslide.ts，音频识别适配器在 src/asr-server.ts 与 scripts/asr-worker.py。外部接入方仍可提供自己的 ASR。真实 DeepSeek 工具调用与合成中文音频的本机 ASR 已验证；真实用户麦克风和环境噪声仍需现场验收。没有 `.pptx` 转换或云部署；实时 Slidev 需要常驻 Node.js 和可写磁盘。现有 Slidev 52 传递依赖仍有审计报告，公开部署前需随上游升级并补充鉴权、文稿隔离。静态内容校验不等同于任意恶意代码沙箱。

参考：[Vercel AI SDK 自定义循环与 prepareStep](https://ai-sdk.dev/docs/agents/loop-control)、[Slidev CLI](https://sli.dev/builtin/cli)。

模型请求使用 `tool_choice=required`，每步最多输出 4096 tokens（包含工具参数）；当前页正文和页面目录按最新状态提供，跨轮只保留最近三轮用户指令，不重复携带旧页面正文及工具记录。工具返回简短结果。DeepSeek 请求关闭 thinking，以兼容强制工具调用。


### 预览缓存与无缝切页

工作台已迁移到 Vue 3，使用固定版本 Slidev 52.20.1 的 Vite 插件、根上下文和页面组件，在同一应用中编译并渲染 Markdown。不存在 React 外壳、后台 iframe 或页面 iframe。原生 Vue 渲染器每次只挂载一个源页面，优先当前页，完成字体、图片和布局检查后发布不可变 DOM 快照。主画布与缩略图使用同一快照和共享的不可变 CSSStyleSheet；Shadow DOM 隔离页面样式与工作台样式。更新或失败时保留旧画面，缩略图不显示更新状态。可见范围外的缩略图卸载，空闲时串行更新。各文稿独立 Markdown 为准，活动文稿通过固定派生入口渲染。快照继续用于只读预览，动画、视频播放和任意脚本组件不属于本工作台的支持范围。

### 页面工具

- `update_page({ page?, title, content, layout? })`：完整替换指定页，页码从 1 开始，省略 `page` 时更新当前页；保留页面 ID，不改变浏览位置。
- `delete_page({ pages: 2 })`：删除单页。
- `delete_page({ pages: [2, 4, 5] })`：以调用前页码一次性删除多页，自动去重；任一页码无效则整次不执行。
- `delete_page({ pages: "all" })`：清空整份演示。删除后至少保留一张空白页；当前页未删除时保持其 ID，删除时选下一张存活页，否则选上一张。

旧的 `update_current_page`、`delete_current_page`、`clear_presentation` 不再暴露给模型；`navigate` 和 `finish` 保持不变。

`edit_page({ page?, field?: "content" | "title", old_string, new_string, replace_all?: boolean })` 精确修改局部文本。页码从 1 开始，默认当前页；默认修改正文。未找到匹配或出现多处匹配且未指定 `replace_all: true` 时返回错误，不写入。`new_string: ""` 删除匹配文本；替换后仍执行页面内容校验。

Agent 允许单次响应产生多个工具调用，沿用 AI SDK 默认执行调度，不添加工具串行队列。仅底层 Markdown 写入保持原子串行保存，防止同时写文件；同批自身修改不会误触发旧版本保护，外部选页和新 steer 仍会阻止过期操作。互相依赖的工具需等上一轮结果；本批任一工具失败时，即使出现 `finish` 也不会提前宣告完成。

`read_page({ pages: 2 | [2, 4] | "all" })` 读取指定页、多页或全部页，返回 `{ revision, currentPage, pages: [{ page, id, title, content, layout }] }`。页码从 1 开始，数组去重，非法页码整次返回错误；读取不会写文件、增加版本或改变浏览位置。修改非当前页先读取，再基于结果调用 `edit_page` / `update_page`。


### 语音到预览的精简路径

语音每片只调用一次 LLM，合并校准、去重和语义分段，返回完整新增文字、分段标记和未完尾句。只有完整内容交给编辑 Agent；尾句保持虚字并参与下一片校准。语音不再请求独立分段接口，纯文字分段异步显示，不阻塞编辑。

选页仅更新服务内存和 SSE，不改 Markdown、不递增内容版本、不触发 Slidev HMR；独立选页版本仍阻止旧 Agent 操作。浏览位置会在下一次内容保存时随文稿保存，单纯切页后重启会恢复上次保存的位置。

每页 Markdown 使用内容指纹，修改一页不会改写其他页的版本字段。仅对内容、布局、顺序或全局视觉配置变化的页面重新生成快照；目录变化复用未改变页面的内容。源 Vue 页面检查资源就绪后，画布与缩略图直接复用结果，不重复执行组件或建立文档上下文。

静音通过采集时的20ms帧低阈值检测，400ms停顿即提交收尾片段，连续静音不请求ASR。校准忙碌时，已完成识别且尚未开始校准的连续片段最多4片、24秒合并调用一次，保留每片原文和时间戳用于去重，不等待凑批、不丢弃新增文字。弱于检测阈值的声音仍可能漏检，需要人工现场调整。

Agent 每轮只把新读到或变化的正文加入上下文一次，未变化时返回unchanged标记。优先使用edit_page和按需read_page。update_page/edit_page/delete_page/navigate可带done:true，整批成功且无新指令时直接结束，省去单独请求finish的一轮；finish保留用于无需修改的情形。工具执行继续遵循SDK默认行为。

前端拒收旧版本预览，每页仅保留已显示版与最新待就绪版，后来的更新替换未展示的中间版；旧画面保持到最新版成功就绪。

### 当前语音模式：MOSS + LLM 工具执行

默认 `ASR_PROVIDER=moss`、`MOSS_SSH_HOST=157`、`MOSS_BASE_URL=http://127.0.0.1:18768`（地址由远端SSH主机访问）。本机通过持久 SSH 连接访问参考部署中的 MOSS-Audio-4B-Instruct 服务（远端 `127.0.0.1:18768`，沿用 balanced 档），将 16kHz PCM 转为临时 WAV 后调用 `/infer`，只要求返回讲话原文。临时音频在请求结束后删除；音频会发送到该 SSH 主机。需要本机已有可无交互登录的 SSH 配置。

语音检测到约400ms停顿立即提交识别，不等待固定4秒；连续讲话每4秒提交一次，保留2秒重叠。静音不持续请求，保留200ms起始音频。端点检测使用20ms音量帧和低阈值，实际断句需人工试听，噪声或轻声可能影响端点。

所有识别结果统一交给后端Agent，没有关键词动作直通。模型同轮返回 `apply_voice({ completed: [{ instruction, actions }], pending, needsFollowUp })`：完整指令立即执行，未完尾句等待下一片；连续讲话不再强制等到停顿。后端按列表顺序逐项执行，所以新增后填写、预算修改后删行等依赖动作可以同一推理计划完成，并保留各中间状态。读取结果后才能决定参数时才继续下一轮。成功动作及结果在录音会话内保留，新语音是顺序续接，不会像普通文本steer那样废弃旧步骤。每个session/seq幂等，冲突重试报错；新说的真实重复要求仍可执行。

当前远端接口返回完整文本，不是原生流式ASR。延迟包括ASR和合并后的Agent，不承诺固定响应时长；内置语音流程不调用旧 `/api/asr/merge` 校准接口。识别失败明确报错，不自动回退到Whisper。若需要旧识别器可显式设 `ASR_PROVIDER=whisper`。

分段细节：麦克风每40ms交付一次音频，按20ms帧检测。起声仍需连续60ms达到0.001 RMS，进入讲话后使用0.0006阈值保留较轻尾音。400ms停顿确认后只保留160ms尾部静音送识别；若4秒边界已经进入静音，先等待停顿判定（额外等待小于400ms），避免立刻拆成定时片段和尾片。缓冲区复用，避免每帧复制整段音频。LLM合并按录音session串行，不同session不再共用等待队列；工具调用规则不变。以上是实现参数，尚未做现场效果验证。

参考 [memora 的持续音频会话和有界队列设计](https://github.com/MaxtuneLee/memora/blob/3e27e7dee9b7d01c1081c5f820e81266812a074c/docs/adr/0004-nemotron-joins-local-model-runtime-with-streaming-asr-protocol.md)，当前保持后端 MOSS 推理和持久 SSH 连接，不引入浏览器模型。MOSS 仍按完整音频片段推理，没有 Nemotron 的跨块编码器缓存。前端最多保留 6 个待校准片段；后端最多接收 6 个在途/排队 ASR 请求，超限明确报错。页面快照以 80ms 合并更新并检查真实 DOM 就绪，加载失败仍保留旧画面。

端到端测试：`node scripts/test-voice-latency.mjs <audio.wav>`（需安装 Playwright，或通过 `PLAYWRIGHT_MODULE` 指定其模块路径）。可用 `VOICE_LATENCY_OUTPUT` 指定每次证据目录。脚本播放音频进入虚拟麦克风，调用真实 ASR、校准模型和 Agent，验证恰好新增一页并等待该页 ID 和版本实际可见；它会修改当前文稿。`result.json` 包含阶段耗时、完整事件和成功/失败状态，失败结果同样保留。此测试不覆盖物理麦克风和环境噪声。


### 无讲话音频拦截

MOSS 转写前，`scripts/moss-worker.py` 使用本机 faster-whisper 自带的 Silero ONNX 模型检测人声（阈值 0.5、最短人声 100ms）。无讲话片段返回空文本和 `speechDetected: false`，不会发送到远端 MOSS；前端与 `/api/voice` 都跳过空转写，不触发编辑 Agent。检测只负责放行，原始语音不被裁剪；没有对英文短语做黑名单过滤。

MOSS 模式也需要先安装 `scripts/asr-requirements.txt`，但不需要下载 Whisper 模型。默认使用 `.data/asr-venv/bin/python`，可通过 `ASR_PYTHON` 覆盖。VAD 依赖缺失会明确报错，不会绕过检测。前端音量阈值仍用于快速分片，最终以服务端人声检测为准。人声检测仍可能误判，真实麦克风环境需现场验证。

### 合并后的语音决策与验收

语音使用温度0的后端模型。累计快照优先于旧pending，避免把重叠片段重复拼成难理解的半句。后端拒绝把待确认尾句或未要求的“待补充/TODO”等占位文本写进页面；遇到错误停止当前批次后续动作，由同一Agent修正，成功前缀不重做。普通文字steer继续保留旧操作失效保护。会话历史和接收去重在当前进程内有效，原始片段与receipt写入 `.data/transcripts/voice-<session>.jsonl`；不承诺崩溃后自动重放操作。

真正空白的default页复用预先加载的单个规范空白文档，仅在后端确认空内容后切换真实页ID和版本，再由Slidev刷新；有正文或其他布局的页继续等待真实编译与资源就绪，不能把空白页的延迟外推为整页生成延迟。

短指令验收：`PLAYWRIGHT_MODULE=<模块路径> VOICE_LATENCY_OUTPUT=<证据目录> node scripts/test-voice-latency.mjs .data/voice-latency/add-page-clear.wav`。测试要求恰好新增一页、实际可见、独立校准为0次、Agent轮数为1次；必须播完录音并等待云端确认后仍无额外修改。`VOICE_VISIBLE_BUDGET_MS=1000` 可把说完到可见低于1秒作为硬门槛，结果另记录实际物理模型请求数。

### 火山 SeedASR 持续双流

设置 `ASR_PROVIDER=volc`、`VOLC_ASR_API_KEY`（或仅含密钥的私有 UTF-8 文件路径 `VOLC_ASR_API_KEY_FILE`），重启后端后刷新网页。默认连接 `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async`，资源固定为 `volc.seedasr.sauc.duration`，使用 Agent Plan 专属密钥。普通语音服务密钥需显式设置 `VOLC_ASR_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`。密钥仅由后端读取，浏览器只连接同源 `/api/asr/stream`。

该模式持续发送16kHz单声道音频，80ms仅为网络传输包，不裁剪、分段或重启云端音频流。临时文本实时显示；连续两次识别一致的前缀中，遇到逗号、句末标点或“然后”“第二行”等后续语句边界，便将累计转写交给后台语音Agent判断完整要求。无标点但重复稳定的假设也可交付。约80ms本地能量静音且云端消费水位已接近末次有声采样（最多一包80ms时间量化误差）时，提前交付最新文字；该提示不表示语义完整，仍由LLM判断。普通增长快照约600ms合并一次，ASR修订立即提交以使旧计划失效，等待接收时只保留最新快照；未完整的名称、金额和对象留在pending。停止录音不再等待本地静音帧，云端最终确认相同文字不会重放动作。

累计快照替换旧转写，不能再拼接一次；相同内容的最终确认不会重放。Agent保留成功工具历史，ASR修订使尚未提交的旧操作失效，已经执行的可逆编辑由Agent按修订内容作必要更正。提前执行使用的是暂稳定转写，不能保证后续ASR永不改字。结束录音会发送最终音频包并等待尾句；断线不会强制提交尚未交付的尾句，也不会撤销已经执行的操作。每个录音会话独立，真实重复指令仍保留。状态接口的 `ready` 表示配置可用，真正鉴权在开始录音的WebSocket握手时发生。

方舟 LLM 配置为 `OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3`、`OPENAI_MODEL=deepseek-v4.1-flash`、`OPENAI_API_KEY=<Plan专属密钥>`、`OPENAI_ENABLE_THINKING=false`，后端使用 `thinking.type=disabled` 兼容强制工具调用。回退语音只需将 `ASR_PROVIDER=moss` 后重启后端、刷新网页。

接口参考：[Agent Plan语音模型](https://docs.volcengine.com/docs/ark/agent-plan-personal-voice-model?lang=zh)、[语音二进制协议](https://www.volcengine.com/docs/6561/1354869)。

无停顿验收音频由 `scripts/make-voice-lifecycle.py` 一次TTS生成，没有插入静音或等待执行；现有 `.data/voice-lifecycle/lifecycle.wav` 长32.594秒。使用隔离工作台执行 `VOICE_TEST_URL=<隔离地址> PLAYWRIGHT_MODULE=<模块路径> node scripts/test-voice-lifecycle.mjs`。断言五个状态按顺序出现，前四步在讲话结束前完成，最后删除测试页，其他页内容和ID不变，且没有半句/未要求内容写入。脚本保留失败证据，不放宽断言重试。

语音指令使用一轮Agent决策，每轮只发送一次模型请求，直接流式接收工具方案。状态接口的 `voiceModelReplicas` 固定为 `1`，SSE保留实际请求计数以便测量。

### Vue 集成验收

`npm run build` 执行 Vue 类型检查及生产构建，`npm test` 包含 Vue 服务端组件渲染检查。`PLAYWRIGHT_MODULE=<Playwright模块路径> npx tsx scripts/test-vue-workspace.mts` 使用独立测试文稿、真实后端和编译器、确定性模型夹具验证文本提交、工具记录、导航、热更新、慢资源、失败恢复、增删页、全屏和60页滚动；临时测试前端使用5273，不改用户的文稿或服务端口。`scripts/test-thumbnails.mjs` 验证原生缩略图挂载边界。

Slidev 的内部 Vue 接口集中在 `src/slidev-api.d.ts` 与 `src/slidev-wrapper.d.ts` 的类型边界，锁定52.20.1；升级时必须重新验证编译、主题样式与HMR。5173入口采用内存路由，页面选择仍由 `/api/view` 和文稿中的稳定页面ID控制。生产构建固定包含构建时的页面；持续编辑需要运行开发编译服务。

多文稿验证：`npm test` 包含权限矩阵、持久化、模式切换、过期任务和语音批量工具测试。`tsx scripts/test-vue-workspace.mts` 使用真实后端、Slidev 和 Chromium，在独立目录运行多文稿浏览器回归；可通过 `PLAYWRIGHT_MODULE` 指定 Playwright 路径。加 `TEST_LIVE_ASR=1` 使用已配置的真实 SeedASR 静音流验证跨模式不断连。`tsx scripts/test-library-voice-live.mts` 使用已配置的真实模型验证累计语音转写到多文稿工具的完整流程，产生正常模型用量，所有文稿隔离在 `.data/`。

## 演示风格与提示词

新建文稿时可选商务稳重、科技未来、学术科研、创意人文、极简汇报五种风格，文字和语音编辑共用文稿风格上下文。两份可独立复制的提示词（整套生成、保真重构）、使用方法和检索依据见 [提示词库](prompts/README.md)。
