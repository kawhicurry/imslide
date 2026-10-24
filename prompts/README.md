# Slidev 演示提示词库

- [Prompt A：从资料生成整套演示](generate-deck.md)：适合主题与材料已备齐的初稿生成。
- [Prompt B：保真重构与风格迁移](refine-deck.md)：适合旧稿精炼、重排和换风格。

两份均可独立复制，包含五种风格、输入参数、Slidev语法与质量检查。它们输出Slidev Markdown，不提供.pptx导出。

| 选项 | 风格 | 叙事与版式特征 |
|---|---|---|
| business | 商务稳重风 | 结论—证据—风险—行动；海军蓝、稳定网格、指标与决策 |
| technology | 科技未来风 | 瓶颈—架构—验证—演进；深底青色、分层架构与代码 |
| academic | 学术科研风 | 问题—方法—实验—局限；浅底、公式、引用与实验口径 |
| humanities | 创意人文风 | 场景—张力—洞察—意义；暖纸色、编辑式不对称排版 |
| minimal | 极简汇报风 | 结论—变化—阻碍—下一步；黑白单强调色、单数字与留白 |

应用内在“新建文稿”旁选择风格，默认商务稳重。新建仍只产生一张空白页；打开后用文字/语音说明生成内容。风格随文稿保存、复制继承，旧稿未指定时沿用既有风格。Agent的create_deck.style也支持上述ID。当前选项不直接给已有页换肤；已有稿换风格可用Prompt B明确要求重构。

运行时规则由src/presentation-styles.ts统一提供给UI与Agent，编辑两份独立提示词时同步五张风格卡。Agent每轮上下文中的designGuidance读取活动文稿，文本和语音共用；没有新增模型调用。

## 检索依据（2026-10-24）

- [Microsoft：基础创建与有效演示技巧](https://support.microsoft.com/en-us/powerpoint/basic-tasks-for-creating-a-powerpoint-presentation)：短句、易读文字、有意义的图像与图表、统一背景和对比。提示词采用这些原则，像素字号是本项目针对画布的建议，不照搬PowerPoint字号。
- [Duarte：对比与叙事](https://www.duarte.com/blog/ultimate-guide-to-contrast/)：根据受众组织现状与可能性、问题与解决、数据与故事的对比，保留视觉呼吸空间。
- [Duarte：演示技能](https://www.duarte.com/blog/presenting/)：单页聚焦一个主旨、减少屏幕文字对讲述的竞争。
- [Slidev：语法](https://sli.dev/guide/syntax)、[布局](https://sli.dev/builtin/layouts)：Markdown、分页frontmatter、两栏插槽等语法；项目实际仍使用52.20.1，只采纳本地已支持的子集。
- [Slidev：自定义Mermaid renderer](https://sli.dev/custom/config-mermaid-renderer)、[Pele API](https://pele.run/api)：Mermaid经Pele输出SVG；使用本地已安装1.9.0，不要求额外脚本。

五类配色、叙事和版式是基于上述原则的项目设计方案，不是这些来源发布的官方模板。
