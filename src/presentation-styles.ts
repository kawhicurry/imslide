/** Shared by the library selector and the text/voice Agent context. */
export const styleIds = ['business', 'technology', 'academic', 'humanities', 'minimal'] as const;
export type PresentationStyle = typeof styleIds[number];
export const presentationStyles: Record<PresentationStyle, { label: string; prompt: string }> = {
  business: { label: '商务稳重风', prompt: '面向决策者：结论→证据→风险→行动。海军蓝 #183153、浅灰白 #F5F7FA、克制金色 #B58A45；正文深灰 #243447。系统无衬线字体。封面左对齐，正文用结论标题与证据区；对比用 two-cols，指标用大数字加口径，计划用时间线。统一细线、稳定边距，每页最多3个重点；不使用霓虹、装饰渐变或密集卡片。最后落到负责人、时间与所需决策，未知项明确待确认。' },
  technology: { label: '科技未来风', prompt: '面向技术与产品受众：瓶颈→架构→机制→验证→演进。深蓝黑 #0B1220、近白 #E6F1FF、青色 #22D3EE，紫色 #A78BFA仅作次级区分。系统无衬线，代码用系统等宽字体。封面大字与简洁几何；正文用分层架构、输入输出流程、基准对比。Mermaid用于真实关系，代码只留关键片段；网格线可极淡，不用发光正文、赛博背景图片或动画。性能数字注明环境和基线；未来能力与已实现能力分开。' },
  academic: { label: '学术科研风', prompt: '面向研究受众：研究问题→相关工作缺口→方法→实验→局限→结论。白底 #FFFFFF、墨蓝 #17324D、青绿强调 #087F8C，正文 #1F2937。标题严谨，系统无衬线正文；公式用KaTeX，变量先定义。采用方法示意与实验结果双栏、带单位和误差说明的图表、精简对比表；每图写可检验的结论。区分事实、假设、推断；保留样本量、数据集、基线、限制与来源。没有资料不得虚构论文、DOI、显著性或实验结果；不把相关性写成因果。' },
  humanities: { label: '创意人文风', prompt: '面向文化与创意受众：具体场景或人物→张力→洞察→意义→开放问题。暖纸白 #F7F1E7、炭黑 #302B28、陶土红 #A64B35、橄榄绿 #65734B。标题可用本机宋体/serif，正文系统无衬线。采用编辑式不对称双栏、短引文、时间线、单张有来源的图像与留白；用版面节奏而非贴纸装饰体现创意。保持清晰阅读顺序，不用随机旋转文字或杂乱拼贴。叙事有温度但不编造人物经历、引文和图片出处。' },
  minimal: { label: '极简汇报风', prompt: '面向快速同步：一句结论→关键变化→阻碍→下一步。白 #FFFFFF、近黑 #18181B、中灰 #52525B，仅一个蓝色强调 #2563EB。系统无衬线；大结论标题、单一数字或紧凑列表，每页最多3项。优先default/center，减少章节页；数据比较只突出差值及口径。大量留白、无装饰图标/阴影/渐变/卡片墙。删冗余措辞不删限定条件；最后写明确下一步，不机械加谢谢页。' },
};
export function stylePrompt(style?: PresentationStyle) {
  return style ? `文稿生成风格：${presentationStyles[style].label}。${presentationStyles[style].prompt}\n将配色与版式落实到单页静态HTML和专用class的局部CSS；不要仅在文案中描述风格。不改全局CSS。HTML容器从起始到闭合标签之间不要插入空白行，所有HTML标签顶格或最多缩进2个空格，避免Markdown把后续HTML当作代码块；CSS放在闭合容器后的style块。default布局已有内边距，内部可用空间约884×456px：自定义内容总高度控制在400px左右，不再叠加40px以上的内边距，不用height:100%撑高；显式重置专用容器内h1/p的默认margin和line-height。三个论点优先横向三列或短行，避免大标题、副标题和三段长文纵向堆叠。注释也须留在画布内，不靠隐藏溢出解决。当前为静态Slidev快照，不使用v-click、动画或交互。只在用户授权生成/重构的范围内应用；局部文字修改保持原版式，用户本次明确要求优先。` : '未指定生成风格：沿用现有文稿视觉语言。';
}
