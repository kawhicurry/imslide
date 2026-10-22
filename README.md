# imslide

**Agent 文字/语音交互工作台 + 只读 Slidev 画布 + 单文件底层能力。**

前端保留文字指令、语音输入和工具执行状态。模型强制只调用工具，完成后调用 `finish`，不输出解释或完成总结。所有文稿创建、内容修改和翻页指令都交给 Agent 执行；没有手动新增页面、源码编辑或直接修改文稿的入口。画布、左侧页面列表与 Agent 共用一个当前页；选中已有页面后，后续指令就操作该页。

系统提示词统一在 [`prompt.ts`](./prompt.ts) 配置，包括幻灯片编辑 Agent、动态文稿上下文前缀和语音转写校准器。修改后重启服务；开发模式会自动重载。

底层的文稿读写、Vercel AI SDK Agent、语音整句稳定处理、steer 注入和本地接入接口均集中在 [`imslide.ts`](./imslide.ts)。所有页及当前页位置统一保存在 **`slides/slides.md` 一个文件**，Slidev 直接监听它并热更新。

## 启动工作台

需要 Node.js 22.12+。

```sh
npm install
cp .env.example .env
# 如需 Agent，填写 OPENAI_API_KEY；可选 OPENAI_MODEL、OPENAI_BASE_URL
npm run dev
```

打开 http://127.0.0.1:5173 。启动器先等待底层服务（3001）初始化文稿，再启动 Slidev（3030），最后启动 Agent 工作台（5173）。三个服务只监听本机。

如凭据已保存在私有配置，可只在 `.env` 中放引用，不复制密钥：

```dotenv
PRIVATE_LLM_CONFIG=~/.private/config.yaml
OPENAI_MODEL=qwen-flash
OPENAI_ENABLE_THINKING=false
```

服务端从 `agent.llm.api_key` 和 `agent.llm.base_url` 读取凭据与地址。显式 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 优先于私有配置；`OPENAI_ENABLE_THINKING=false` 为兼容服务请求加入非思考模式开关。不要将这些参数放入 `VITE_*`，也不要提交 `.env`。

不配置模型也能查看已有文稿。首次运行无文稿时，只创建一张空白页。已存在的文稿会保留。旧版 `.data/deck.json` 只用于一次性恢复匹配文稿的页标识、当前位置和版本；迁移后不再读写它，重启仅依赖 `slides.md`。

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

前端使用 AudioWorklet 连续采集 PCM，每 4 秒新增音频提交一次，携带前 2 秒重叠：窗口依次为 0–4、2–8、6–12 秒。录音与请求异步运行，不再等待文字连续两次一致，也不会因 24 秒未稳定而停录。本机 Whisper 工作进程排队识别，慢请求不会阻止继续采集。

识别结果按录音顺序交给配置的 LLM，仅带最近已写入的 128 个 Unicode 字符作为上下文，通过工具调用校正同音错字、去除口吃和重叠重复，追加合并。音频留在本机；原始转写及上下文会发送给已配置模型。校准后的文字显示实字并提交文稿 Agent；等待校准的原始文字显示虚字。校准不能保证消除所有误识别。

点击停止会提交最后不足 4 秒的尾段并等待队列完成。失败片段提示错误，后续片段继续；校准失败的文字保留虚字且不执行。请求重试使用同一会话和片段编号，避免重复追加。原始转写、128 字上下文、校准追加内容及时间按会话记录在本机 `.data/transcripts/*.jsonl`（权限 600），不保存音频。服务重启后可从日志恢复合并上下文和去重结果。

本机 ASR 首次配置（Python 3.11+；可通过 `ASR_PYTHON` 指定解释器）：

```sh
python3 -m venv .data/asr-venv
.data/asr-venv/bin/pip install -r scripts/asr-requirements.txt
.data/asr-venv/bin/python -c "from faster_whisper.utils import download_model; download_model('base')"
# .env 中设置 ASR_PYTHON 为该 Python 的绝对路径，ASR_MODEL=base
```

运行时只加载本地模型缓存（也可把 `ASR_MODEL` 设为本机 CTranslate2 模型目录），不自动下载。依赖缺失会明确提示，文字输入仍可使用。`GET /api/asr/status` 预热模型，`POST /api/asr` 接受最长 24 秒的 16kHz 单声道 Float32 PCM，返回带时间戳的识别词。浏览器需要麦克风权限和 AudioWorklet 支持。

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
| `POST /api/view` | 以 `{pageId}` 选择已有页，同步画布与 Agent 当前页 |

前端文字对话使用 `POST /api/chat`（`{message, id?, mode: "steer"}`），已定稿语音与外部调用使用 `POST /api/input`。两者均返回接收确认，Agent 回复和页面更新通过 `/api/events` 流式返回。不提供手动新增/直接编辑文稿接口，只有 Agent 工具可以写入文稿：

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
                  slides/slides.md
                         ↓
                 Slidev 监听与热更新
                         ↓
                   前端只读画布 + Agent 对话面板
```

页正文使用标准 Slidev Markdown；`---` 分隔页面，frontmatter 中的 `imslide`、`imslideId`、`imslideTitle`、`imslideContentKey` 保存文稿信息及页面内容指纹。不再使用第二份 JSON 文稿。原子替换源文件防止读取到半写入状态。

当前页统一保存在 `deck.current`，前端没有第二套浏览游标。左侧或底部选择已有页面，通过 `POST /api/view` 提交稳定的 `pageId`；该接口只允许选择已有页，不能新增、删除或修改正文。随后发出的对话会等待选页确认，确保 Agent 操作的就是所选页面。运行中的旧工具若遇到页版本变化，会跳过并在新上下文中重新规划。

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

嵌入的 Slidev 仅作为后台渲染器，提前加载并挂载所有页。每次文稿热更新后等待 450ms 合并更新，再生成包含独立样式的页面快照。前台为每页保留已就绪的 iframe，点击切页直接显示对应缓存，不经过 Slidev 路由转场。新版页面在隐藏 iframe 中等待字体、图片和布局就绪后整体替换；加载期间保持旧版，加载失败不清空画布。快照仅用于只读预览，文稿仍以 slides/slides.md 为准。页面 CSS 动画在快照中关闭，避免切换及热更新抖动。

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

每页 Markdown 使用内容指纹，修改一页不会改写其他页的版本字段。首次预加载全部页，此后仅对内容、布局、顺序或全局视觉配置变化的页生成快照；传输只包含变化页及目录。未变化页更新目录元数据并复用原 iframe。图片、字体只在前台待替换 iframe 检查一次，加载失败保留旧画面。

静音优化仅检测每个窗口的新增音频（20ms 帧、低阈值），排除重叠区；保留一次语音后的收尾窗口，连续静音不请求ASR。校准忙碌时，已完成识别且尚未开始校准的连续片段最多4片、24秒合并调用一次，保留每片原文和时间戳用于去重，不等待凑批、不丢弃新增文字。弱于检测阈值的声音仍可能漏检，需要人工现场调整。

Agent 每轮只把新读到或变化的正文加入上下文一次，未变化时返回unchanged标记。优先使用edit_page和按需read_page。update_page/edit_page/delete_page/navigate可带done:true，整批成功且无新指令时直接结束，省去单独请求finish的一轮；finish保留用于无需修改的情形。工具执行继续遵循SDK默认行为。

前端拒收旧版本预览，每页仅保留已显示版与最新待就绪版，后来的更新替换未展示的中间版；旧画面保持到最新版成功就绪。
