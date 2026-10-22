# imslide

**Agent 文字/语音交互工作台 + 只读 Slidev 画布 + 单文件底层能力。**

前端保留文字对话、语音输入和 Agent 流式回复。所有文稿创建、内容修改和翻页指令都交给 Agent 执行；没有手动新增页面、源码编辑或直接修改文稿的入口。画布可浏览已有页面或跟随 Agent 当前页，浏览页码只存在前端，不改变 Agent 的当前页。

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

前端提供麦克风入口，推荐使用 Chrome / Edge 并允许麦克风权限。浏览器识别草稿只在本地实时显示，不向 Agent 提交。当前句子的全部识别片段均已 final、说话结束且稳定 1200ms 后，才通过 `/api/input` 发送一次完整语句，标记 `endOfUtterance: true`。开始继续说话或出现新的 interim 会取消稳定计时；停止麦克风不会强制发送未定稿的半句。

文字输入和已定稿的语音均可在 Agent 运行中继续发送，传输只等待接收确认，不等待上一轮完成，运行中进入同一个 run 的 steer 处理。Agent 的文本回复通过 SSE 实时显示在对话面板。

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

页正文使用标准 Slidev Markdown；`---` 分隔页面，frontmatter 中的 `imslide`、`imslideId`、`imslideTitle` 保存当前页、版本和页面标识。不再使用第二份 JSON 文稿。原子替换源文件防止读取到半写入状态。

查看器默认跟随 Agent 的当前页。手动浏览已有页后暂停跟随，点击“跟随 Agent 当前页”恢复。查看器前后按钮在首尾禁用，不会自动创建页面。Slidev 内置编辑器也已关闭。

## 验证与边界

```sh
npm run build
npm test
```

测试使用临时文件和本地 OpenAI-compatible SSE 模型服务，覆盖真实 Vercel ToolLoopAgent 的工具调用、处理中 steer、旧工具跳过、纯文本回复尾部续接、语音去重、interim 阻止半句提交、整句稳定计时、前后翻页，以及仅凭 Markdown 恢复文稿（含备注和空白）。不使用真实模型密钥，也不覆盖本地文稿。

这是单用户、本机运行能力；最多 60 页，每页正文 24,000 字符，运行中最多等待 16 条 steer，每个 run 最多接收 64 条指令、执行 32 步或持续 120 秒。一个文稿同时只能由一个能力实例管理，不支持多进程并发写同一文件。对话和语音去重记录不跨进程保留；失败后的已保存内容不会回滚。

前端使用浏览器提供的语音识别服务，支持程度和可用性取决于浏览器及网络；外部接入方也可提供自己的 ASR。单文件底层处理识别事件，不直接识别音频。真实云端模型与真实麦克风识别尚需配置密钥、浏览器权限和服务后验证。没有 `.pptx` 转换或云部署；实时 Slidev 需要常驻 Node.js 和可写磁盘。现有 Slidev 52 传递依赖仍有审计报告，公开部署前需随上游升级并补充鉴权、文稿隔离。静态内容校验不等同于任意恶意代码沙箱。

参考：[Vercel AI SDK 自定义循环与 prepareStep](https://ai-sdk.dev/docs/agents/loop-control)、[Slidev CLI](https://sli.dev/builtin/cli)。
