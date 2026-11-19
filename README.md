# Report Render CLI

离线渲染相似度报告和 AI 报告。输入是已有的报告素材；本工具不负责登录、下载素材或检测 AI。

## 安装

需要 Node.js 20 或更高版本：

```bash
npm ci
node render_cli.js --help
```

仓库包含运行所需的字体和图标。也可以通过 `--assets-dir` 或环境变量 `REPORT_RENDER_ASSETS_DIR` 指定其他资源目录，命令行参数优先。

## 使用

为每份报告准备输入目录、清单文件和**已存在的独立输出目录**：

```bash
mkdir -p work/input work/output
node render_cli.js --manifest work/input/manifest.json --output-dir work/output
```

输入与输出目录不能相同，也不能互相包含。相对素材路径相对于清单所在目录，且必须位于该目录内。每次调用生成一份报告，不覆盖已有的同名结果；重新渲染请使用新的输出目录。

### 相似度报告清单

```json
{
  "version": 1,
  "type": "similarity",
  "metadata": {
    "submission_id": "example:1",
    "score_percent": 8,
    "author_name": "Example Author",
    "document_name": "example.docx"
  },
  "materials": {
    "blank": "blank.pdf",
    "glyph": "glyph.json",
    "submission": "submission.json",
    "report": "report.json",
    "overview": "overview_tagged.json"
  }
}
```

`overview` 必须包含 `taggedView` 对象。四类 Match Groups 的百分比取自对应分类的 `overallMatchPercentage`；数量目前按来源的 `matchGroups` 条目数汇总，尚未验证与官网计数完全一致。

### AI 报告清单

```json
{
  "version": 1,
  "type": "ai",
  "metadata": {
    "submission_id": "example:1",
    "score_percent": 58,
    "author_name": "Example Author",
    "document_name": "example.docx"
  },
  "materials": {
    "blank": "blank.pdf",
    "glyph": "glyph.json",
    "submission": "submission.json",
    "report": "ai_writing_report.json"
  }
}
```

AI 素材 `report` 必须包含 `sentences` 数组；显示的 AI 句子数读取 `resultSummary.aiwSentenceCount`，缺失时显示 `-`。AI 分数为 0 或至少 20% 时显示统计行；正数低于 20% 时隐藏该行及正文高亮。

`score_percent` 必须为 0–100 的数值，而非 0–1 的比例。未知分数或缺失素材不能用 0 或空报告代替。`author_name`、`document_name` 可省略。需要为超长文件名生成可重试的稳定替代名时，可传入非空 `metadata.cover_name_seed`，同一任务的两种报告须使用相同种子。

每次成功时，标准输出为一个 JSON 对象，包含 `type`、生成的 `file`、`bytes` 和 `sha256`。输出文件名为 `similarity.pdf` 或 `ai.pdf`。失败时标准错误输出诊断，退出码分别为：`2` 参数或清单无效、`3` 素材无效、`4` 渲染或发布失败。

## 测试

```bash
npm test
```

测试使用合成素材，不访问官网。渲染器读取的 JSON 单文件最多 16 MiB，源 PDF 和生成 PDF 单文件最多 100 MiB。

## 上传前检查

不要提交实际报告、原始文档、包含个人信息的 JSON、凭据或 `node_modules`。字体许可与图标说明见 [assets/NOTICE.txt](assets/NOTICE.txt)；在公开上传或再分发 logo 和图标前，请确认相应授权和商标使用权限。
