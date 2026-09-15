---
name: thesis-citation
description: 参考文献引用规范（GB/T 7714-2015 顺序编码制）。用于论文与开题报告的引用标注、文末参考文献表著录、文献库与正文的双向一致性检查。
---

# 引用规范（GB/T 7714-2015）

**红线**：每条参考文献必须真实存在、真实检索所得（见 thesis-literature）。本技能只解决"格式对不对"，不解决"文献假不假"——后者由检索留痕保证。

## 1. 引用体系：顺序编码制

- 正文引用处以上标或方括号标注序号：[1]、[2-4]、[1,3]。
- 文末参考文献表**按正文首次出现的顺序编号**，不是按字母序。
- 同一文献多次引用用同一序号。
- 格式细节以学校规范文件为准（06-论文/assets/学校模板/）；以下为 GB/T 7714-2015 通用形式。

## 2. 主要文献类型著录格式

| 类型 | 标识 | 著录格式（要点） |
|---|---|---|
| 期刊论文 | [J] | 作者. 题名[J]. 刊名, 年, 卷(期): 起止页码. |
| 专著 | [M] | 作者. 书名[M]. 版本. 出版地: 出版者, 年: 页码. |
| 学位论文 | [D] | 作者. 题名[D]. 城市: 学校, 年. |
| 会议论文 | [C] | 作者. 题名[C]//会议录名. 出版地: 出版者, 年: 页码. |
| 电子文献 | [EB/OL] | 作者. 题名[EB/OL]. (发布日期)[引用日期]. URL. |
| 标准 | [S] | 标准编号, 标准名称[S]. |
| 专利 | [P] | 申请者. 专利名: 专利号[P]. 公告日期. |

通用细则：
- 作者 3 人以内全列；超过 3 人列前 3 人后加", 等"。
- 英文作者姓前名后、名字缩写（如 `VASWANI A, SHAZEER N, PARMAR N, et al.`）。
- 中文文献标点用中文标点；英文文献用英文标点。
- 有 DOI 的可附 DOI；电子文献必须附 URL 与引用日期。

### 2.1 完整示例（照此格式书写）

```
[1] 王伟, 李强, 张敏. 基于深度学习的目标检测算法综述[J]. 计算机学报, 2021, 44(5): 801-820.
[2] VASWANI A, SHAZEER N, PARMAR N, et al. Attention is all you need[C]//Advances in Neural Information Processing Systems. Long Beach: Curran Associates, 2017: 5998-6008.
[3] 陈晨. 基于卷积神经网络的课堂行为识别系统设计与实现[D]. 北京: 北京邮电大学, 2022.
[4] HE K, ZHANG X, REN S, et al. Deep residual learning for image recognition[C]//Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition. Las Vegas: IEEE, 2016: 770-778.
[5] DEVLIN J, CHANG M W, LEE K, et al. BERT: pre-training of deep bidirectional transformers for language understanding[EB/OL]. (2019-05-24)[2026-02-10]. https://arxiv.org/abs/1810.04805.
[6] 国家标准化管理委员会. GB/T 7714—2015, 信息与文献 参考文献著录规则[S]. 北京: 中国标准出版社, 2015.
```

## 3. 正文标注细则

- 引用标注放在所引内容之后、**句号之前**："…方法在图像分类中取得显著效果[3]。"
- 作为句子成分时融入正文："文献[3]提出了一种…方法"。
- 多处支撑一个论断：`[2,5-7]`；连续编号用连字符：`[2-4]`。
- **每章至少为绪论与相关技术章必须带引用**（thesis_review 会检查引用编号与 refs.bib 的对应关系）。
- 摘要、致谢、图表标题中不出现引用标注；附录中的引用与正文共享同一编号体系。
- **每条正文引用都能在 refs.bib 找到，refs.bib 每条都被正文引用**（thesis_check 会校验双向一致）。

## 4. 常见错误（写作与检查时对照）

- 文末顺序与正文首次出现顺序不一致。
- 电子文献漏 URL/引用日期。
- 作者缩写格式混乱（`A. Vaswani` 应作 `VASWANI A`）。
- 引用了从未读过的文献（间接引用）：应标注"转引自"或找到原文献读后再引。
- 文献"躺尸"：refs.bib 有但正文没引用——检查时删除或补引。

## 5. 与文献库的协作

- 收录文献：thesis_lit_save 写入 02-文献/refs.bib（含 DOI/URL）。
- 写作时：只引用 refs.bib 中条目；正文标注序号，文末著录由构建工具（M4）自动生成或手工按本节格式书写。
- 检查时：thesis_check 输出"正文引用 ↔ refs.bib"双向差异清单。
