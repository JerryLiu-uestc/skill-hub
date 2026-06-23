# Skill Hub — UI 设计审查报告

> **审查人**：UI Designer | **日期**：2026-06-23 | **版本**：0.4.0
>
> 本报告对 Skill Hub 桌面应用的视觉设计、交互模式、组件架构、无障碍性和开发交付进行全面审查。

---

## 执行摘要

Skill Hub 是一款设计质量**中上**的桌面应用。深色主题的色彩系统、毛玻璃效果和微交互都有亮点。但同时存在**代码架构性债务**和若干可用性问题，主要集中在：

1. **单文件巨型组件**（App.tsx 约 2500 行）导致可维护性差
2. **CSS 组织**（单文件约 2060 行）缺乏模块化
3. **部分交互反馈不足**，空状态和加载状态可优化
4. **亮色主题存在色彩一致性问题**

总体评分：**视觉设计 8/10** | **交互设计 7/10** | **架构 5/10** | **无障碍 8/10**

---

## 1. 视觉设计系统审查

### 1.1 色彩系统

| 维度 | 评分 | 说明 |
|------|------|------|
| 深色主题 | ★★★★☆ | `#0a0f1c` 海军蓝基调 + `#38bdf8` 天蓝强调色，搭配协调 |
| 亮色主题 | ★★★☆☆ | 基础色合理，但强调色梯度未同步切换 |
| 语义色 | ★★★★☆ | 成功/警告/危险色区分清晰 |
| 对比度 | ★★★★☆ | WCAG AA 大体满足，个别场景待验证 |

#### 🔴 问题：亮色主题强调色不一致

```css
/* 深色主题 — accent 是天蓝色 */
--accent: #38bdf8;
--accent-grad: linear-gradient(135deg, #6366f1 0%, #0ea5e9 100%);

/* 亮色主题 — accent 是深蓝色，但 accent-grad 没有更新 */
--accent: #2563eb;
--accent-grad: /* 未定义！继承深色的靛蓝→天蓝渐变 */;
```

**建议**：为亮色主题定义独立的强调渐变：
```css
:root[data-theme="light"] {
  --accent-grad: linear-gradient(135deg, #4f46e5 0%, #2563eb 100%);
  --accent-glow: rgba(37, 99, 235, 0.22);
}
```

#### 🟡 建议：增加色彩 token 粒度

当前 `--accent` 和 `--primary` 指向同一值，建议区分：
- `--accent`：品牌强调色（用于按钮、链接等交互元素）
- `--accent-hover`：hover 状态色
- `--accent-muted`：淡化强调色（用于背景）

### 1.2 排版系统

#### ✅ 优点
- Inter 字体选择优秀，现代且易读
- 字号层级分明（11px → 12px → 15px → 17px → 23px → 26px → 32px）
- `letter-spacing: -0.02em` 在大标题上的应用恰当
- `-webkit-font-smoothing: antialiased` 保障 macOS 渲染质量

#### 🔴 问题：字号跨度跳跃过大

```
11px (eyebrow) → 12px → 13px → 15px → 17px → 23px → 26px → 32px (h1)
```

缺少 18px、20px 等中间尺寸，导致某些场景下信息层级过渡生硬。建议补充：
```css
--font-size-lg: 1.125rem;   /* 18px */
--font-size-xl: 1.25rem;    /* 20px */
```

#### 🟡 建议：表头和标签文字可读性

```css
.table-header {
  font-size: 11px;      /* ← 偏小 */
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
```

11px 大写字母对部分用户阅读困难。建议提升至 12px，letter-spacing 降至 0.03em。

### 1.3 间距系统

#### ✅ 优点
- 整体间距一致性好（10px / 12px / 14px / 16px / 18px / 22px 等）
- 内容区 `padding: 30px 36px` 呼吸感充足
- 卡片内边距（14-22px）合理

#### 🟡 建议：规范化 spacing token

当前间距值散布在 CSS 各处，缺乏 token 抽象。建议定义：
```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
}
```

### 1.4 圆角系统

| 用途 | 值 | 评价 |
|------|-----|------|
| `--radius-sm` | 10px | 按钮、输入框 — 合理 |
| `--radius-md` | 14px | 卡片、面板 — 合理 |
| `--radius-lg` | 20px | 对话框 — 偏大 |
| `--radius-pill` | 999px | 徽章、标签 — 合理 |

圆角值整体偏大，对于 macOS 原生风格尚可，但在 Windows 平台上可能显得过于"软"。这不是硬伤，但值得注意。

### 1.5 阴影与景深

#### ✅ 优点
- 三层阴影系统（sm / md / glow）职责明确
- 发光阴影（shadow-glow）用于强调按钮，创意好
- 浅色主题阴影透明度适当降低

#### 🟡 建议
当前 shadows 使用黑色/强调色混用，建议改为统一语义：
```css
--shadow-elevation-1: /* 卡片悬停 */
--shadow-elevation-2: /* 面板/抽屉 */
--shadow-glow:        /* 强调态（保持） */
```

---

## 2. 组件审查

### 2.1 按钮系统

| 变体 | 评分 | 说明 |
|------|------|------|
| `.primary` | ★★★★☆ | 渐变背景 + 发光阴影，视觉冲击力强 |
| `.secondary` | ★★★★☆ | 半透明 accent 背景，区分清晰 |
| `.ghost` | ★★★☆☆ | **缺少明确的 hover 样式定义** |
| `.danger` | ★★★★☆ | 红色警告主题统一 |
| `.link-button` | ★★★★☆ | 文本链接样式恰当 |
| `.compact` | ★★★☆☆ | 30px min-height 偏小，触摸目标不足 |

#### 🔴 问题：ghost 按钮缺少 hover 状态

```css
.ghost {
  background: var(--bg-inset);
  border: 1px solid var(--border-soft);
  color: var(--text-secondary);
}
/* ← 没有 :hover 定义！ */
```

其他变体都有 hover 样式，唯独 ghost 遗漏。建议：
```css
.ghost:hover:not(:disabled) {
  background: var(--bg-elevated);
  border-color: var(--border-strong);
  color: var(--text-primary);
}
```

#### 🟡 建议：添加 active/pressed 状态

所有按钮变体缺少 `:active` 状态的视觉反馈（按下缩放/凹陷效果）。建议：
```css
.primary:active:not(:disabled) {
  transform: scale(0.97);
}
```

### 2.2 输入控件

#### ✅ 优点
- Focus 环使用 `box-shadow` + accent 色，可见性良好
- Placeholder 颜色使用 muted 色，语义正确
- Select 与 Input 样式一致

#### 🟡 建议
- 错误态未有专门样式——建议增加 `.input-error` 类
- 缺少字符计数器或输入提示（form-input hint）

### 2.3 导航系统（LimelightNav）

#### ✅ 优点
- 创意独特的"聚光灯"指示器效果
- 动画过渡平滑（`duration-400 ease-in-out`）
- 图标 + 标签组合清晰
- 垂直/水平方向支持灵活

#### 🔴 问题：侧边栏品牌标识不完整

```css
.brand-text {
  display: none;  /* ← 品牌文字被隐藏了！ */
}
```

品牌区域只有一个 "SH" 标志位，缺少完整的应用名称。在导航栏仅有图标的情况下，新用户可能难以识别应用身份。

**建议**：在小尺寸时保持图标，但在侧边栏宽度大于等于 116px 时显示品牌文字。

### 2.4 资源列表 / 卡片

#### ✅ 优点
- 列表/网格双视图切换，满足不同场景
- 选中态清晰（左侧 accent 色条 + 背景高亮）
- 卡片 hover 效果细腻（位移 + 发光边框）
- 路径截断处理得体

#### 🟡 建议
- 列表视图下，行高 68px 对于信息密度来说可能偏高——可考虑紧凑模式
- 空状态设计过于朴素（纯文字居中），可考虑添加插图或引导性文案

### 2.5 市场视图

#### ✅ 优点
- 排行榜前 3 名的金银铜徽章设计出彩
- 来源标签（Official/Community/Index）色彩编码清晰
- 已安装板块独立展示，逻辑合理
- 热度/星标/名称三种排序覆盖主要场景

#### 🔴 问题：筛选按钮（🔽 SlidersHorizontal）无实际功能

市场搜索栏右侧的筛选图标按钮看起来是可交互的，但点击后似乎没有任何筛选面板展开。这会降低用户信任度。

**建议**：要么实现筛选面板（如按来源、按星标范围），要么移除该按钮。

#### 🟡 建议：市场卡片网格间距不一致

```css
.market-grid {
  gap: 14px;   /* 市场卡片网格 */
}

.market-directory-list {
  gap: 8px 42px;  /* 目录列表 —— 行列间距差异大 */
}
```

建议统一 gap 为 12-16px 范围。

### 2.6 详情抽屉（Drawer）

#### ✅ 优点
- 420px 固定宽度 + 独立滚动，信息呈现清晰
- `<dl>` 语义标签使用恰当
- 摘要展开/折叠功能实用
- 更新检查区块 UI 完整

#### 🟡 建议
- 抽屉缺少关闭按钮（依赖选中其他资源来切换，不够直观）
- 删除按钮的二次确认（先点一次变"确认删除"再点一次）是好的安全机制，但可以在第一次点击时给出更明显的视觉警告（如按钮抖动或红色闪烁）

### 2.7 设置页面

#### 🔴 问题：设置页面视觉风格与主应用割裂

设置页面使用更扁平的白色/浅色卡片风格，与主应用的深色毛玻璃风格不一致。设置卡片缺少与主视图相同的 `backdrop-filter` 和阴影效果。

**建议**：统一设置页面的视觉语言：
```css
.setting-card {
  background: var(--bg-elevated);
  backdrop-filter: blur(16px);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}
```

#### 🟡 建议
- 路径列表中删除按钮使用 `danger-small` 类，样式与其他 danger 按钮不一致
- 主题切换的 segmented control 设计优秀，可以复用到其他场景

---

## 3. 交互与动画

### 3.1 过渡动画

#### ✅ 优点
- 统一使用 `cubic-bezier(0.22, 0.61, 0.36, 1)` 缓动函数
- 尊重 `prefers-reduced-motion` 用户偏好
- 卡片 hover 的 `translateY(-1px)` 微交互恰到好处

### 3.2 加载状态

#### ✅ 优点
- Rose loader 动画创意十足，差异化明显
- 市场加载有分源状态面板，让用户了解进度

#### 🔴 问题：Rose loader 性能隐患

Rose loader 使用 76 个独立粒子，每个粒子有独立的 CSS keyframes 动画和 box-shadow。在低性能设备上可能导致掉帧。

**建议**：在性能敏感场景下降级为简单旋转动画，或减少粒子数量至 32 个。

#### 🟡 建议：缺少内容骨架屏

资源列表首次加载时只有顶部 notice 文本提示，缺少骨架屏（skeleton screen）让用户感知内容即将出现。

### 3.3 通知系统

#### 🔴 问题：通知信息呈现单一

notice 栏是单行文本，新消息直接替换旧消息，用户可能错过重要信息。

**建议**：
1. 短期：为 notice 添加淡入动画
2. 长期：实现 toast 队列系统，支持多条通知并存

---

## 4. 无障碍性审查

### 4.1 WCAG 合规度

| 标准 | 状态 | 说明 |
|------|------|------|
| 颜色对比度 ≥ 4.5:1 | ✅ 大体满足 | 深色主题文本 #f1f6fd / 背景 #0a0f1c → 14.5:1 |
| 键盘导航 | ✅ 大部分支持 | 按钮可聚焦，但部分自定义组件可能缺失 |
| Focus 指示器 | ⚠️ 不完整 | 部分元素 focus 样式缺失（见下文） |
| ARIA 标签 | ✅ 良好 | 大量使用 aria-label / aria-selected |
| 屏幕阅读器 | ✅ 良好 | 语义化结构 + 描述性标签 |
| prefers-reduced-motion | ✅ 支持 | 动画在用户偏好下禁用 |
| 触摸目标 ≥ 44px | ⚠️ 部分不足 | `.compact` 按钮 30px 不达标 |

#### 🔴 问题：卡片和行缺少 :focus-visible 样式

```css
.resource-card:hover,
.resource-card.selected {
  /* 有 hover 和 selected 样式 */
}
/* ← 没有 :focus-visible 样式！ */
```

键盘用户通过 Tab 导航到卡片时无法看到当前聚焦位置。建议为所有可聚焦元素添加：
```css
.resource-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

#### 🟡 建议：11px 文字需要更多对比度

Eyebrow 文字（11px, `--text-muted`）属于小字体，WCAG 要求 4.5:1 对比度。需验证在亮色主题下是否达标。

---

## 5. 响应式设计

### ✅ 优点
- 两个明确的断点设计（1000px / 760px）
- 侧边栏在移动端隐藏为顶部导航，布局合理
- 卡片网格自适应列数（`auto-fill, minmax`）

### 🟡 建议
- 当前最小宽度为 320px，但 760px 以下侧边栏完全隐藏——在 760-1000px 之间可考虑缩小侧边栏宽度（如 64px 仅图标）而非完全隐藏
- 市场页在 1000px 断点下的工具栏重排逻辑可读性下降，需要更多测试

---

## 6. 代码架构建议

### 🔴 紧急：拆分单文件巨型组件

**当前状态**：
- `App.tsx`：约 2500 行，包含 1 个主组件 + 7 个子组件 + 40+ 个工具函数
- `App.css`：约 2060 行，包含所有页面所有组件的样式

**建议拆分**：

```
src/
├── App.tsx                    # 主应用壳（约 300 行）
├── App.css                    # 全局样式 + 主题变量（约 200 行）
├── hooks/
│   ├── useInventory.ts        # 资源列表逻辑
│   ├── useMarket.ts           # 市场逻辑
│   ├── useAppUpdate.ts        # 自更新逻辑
│   └── useSettings.ts         # 设置逻辑
├── components/
│   ├── layout/
│   │   ├── Shell.tsx          # 主布局
│   │   ├── Sidebar.tsx        # 侧边栏
│   │   ├── TopBar.tsx         # 顶栏
│   │   └── Notice.tsx         # 通知条
│   ├── overview/
│   │   ├── MetricCard.tsx     # 指标卡片
│   │   └── MetricCard.css
│   ├── inventory/
│   │   ├── ResourceList.tsx   # 列表视图
│   │   ├── ResourceCard.tsx   # 卡片视图
│   │   ├── ResourceDrawer.tsx # 详情抽屉
│   │   ├── SourceTabs.tsx     # 来源筛选标签
│   │   └── inventory.css
│   ├── market/
│   │   ├── MarketPanel.tsx
│   │   ├── MarketDirectory.tsx
│   │   ├── MarketCard.tsx
│   │   └── market.css
│   ├── settings/
│   │   ├── SettingsPanel.tsx
│   │   └── settings.css
│   ├── shared/
│   │   ├── SourceBadge.tsx
│   │   ├── HostChip.tsx
│   │   ├── RoseLoader.tsx
│   │   └── shared.css
│   └── ui/
│       └── limelight-nav.tsx
├── styles/
│   ├── tokens.css             # 设计 token
│   ├── base.css               # 基础重置样式
│   └── utilities.css          # 通用工具类
└── types.ts
```

### 🟡 建议：建立设计 token 文件

将 CSS 变量从 App.css 中提取为独立的 `tokens.css`，其他组件 CSS 通过 `@import` 引用。

---

## 7. 改进优先级矩阵

| 优先级 | 类别 | 改进项 | 预估工时 |
|--------|------|--------|---------|
| 🔴 P0 | 代码架构 | 拆分 App.tsx 巨型组件 | 3-5天 |
| 🔴 P0 | 代码架构 | 拆分 App.css 为模块化样式 | 1-2天 |
| 🔴 P1 | 视觉 | 修复亮色主题 accent-grad 缺失 | 10分钟 |
| 🔴 P1 | 视觉 | 为 ghost 按钮添加 hover 样式 | 5分钟 |
| 🔴 P1 | 无障碍 | 为可聚焦元素添加 focus-visible 样式 | 1小时 |
| 🟡 P2 | 视觉 | 设置页面风格与主应用统一 | 2小时 |
| 🟡 P2 | 交互 | 实现筛选面板（替代空按钮） | 4小时 |
| 🟡 P2 | 交互 | 添加内容骨架屏 | 3小时 |
| 🟡 P2 | 视觉 | 建立 spacing / font-size token 系统 | 1小时 |
| 🟢 P3 | 视觉 | 空状态添加插图和引导文案 | 2小时 |
| 🟢 P3 | 交互 | 通知系统改为 toast 队列 | 4小时 |
| 🟢 P3 | 性能 | Rose loader 粒子数优化 | 30分钟 |

---

## 8. 总结

Skill Hub 是一款有品位的桌面应用，在视觉氛围营造上投入了明显的心思。深色主题的海军蓝基调 + 天蓝强调色的配色方案独特且优雅，LimelightNav 和 Rose loader 等创意元素为产品增添了辨识度。

当前最大的短板不是视觉设计本身，而是**代码架构**——2500 行的 App.tsx 和 2060 行的 App.css 会让后续的 UI 迭代变得日益困难。建议优先进行组件拆分和样式模块化，再逐步修复视觉细节问题。

如果在接下来的迭代中逐步落实本报告中的 P0/P1 改进项，Skill Hub 的 UI 质量可以从"中上"提升到"优秀"水平。

---

**UI Designer** | 2026-06-23
