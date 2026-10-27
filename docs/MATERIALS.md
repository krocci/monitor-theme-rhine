# 莱茵生命素材参考库

整理日期：2026-10-25，Asia/Shanghai。

已为 Rhine Observation 建立本机公开素材参考库，供后续设计研究。初版共 101 个索引条目，包含 54 张原始图片和 47 个资料入口；图片约 55.4 MiB。原图、清单、图册和核验记录存放在 Git 忽略的 `local/material-library/rhine-lab/`，不进入公开仓库或主题安装包。

## 本机入口

用浏览器打开 `local/material-library/rhine-lab/index.html`，可以搜索角色、名称和标签，按分类与来源筛选。`README.md` 说明收录范围，`CATALOG.md` 提供文字目录，`catalog.json` 记录逐项来源、尺寸、哈希与使用边界。

浏览入口只引用本地图片，不依赖远程字体。漫画正文、音频和视频保留外部阅读或播放入口；本次不将这些内容嵌入主题。

## 公开来源

| 来源 | 研究内容 |
|---|---|
| [明日方舟四周年专题](https://ak.hypergryph.com/special/4th-anniversary/index.html) | 《孤星》相关角色、专题背景、网格和装饰；周年通用画面另标为扩展 |
| [泰拉记事社：罗德岛源石记事——莱茵生命](https://comic.hypergryph.com/terra-historicus/comic/1421) | 官方漫画封面、章节入口、实验室与人物关系参照 |
| [塞壬唱片](https://monster-siren.hypergryph.com/music) | 相关 OST、EP、封面和官方曲目入口 |
| [特别映像：莱茵生命·访问](https://www.bilibili.com/video/BV1rr4y1b7sz/) | 官方影像参考 |
| [PRTS：莱茵生命](https://prts.wiki/w/泰拉大典:组织/莱茵生命) | 社区组织资料、关联角色和游戏美术文件页 |
| [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI) | 社区界面设计与信息组织参考 |

活动覆盖《孤岛风云》《绿野幻梦》《孤星》《未许之地》。角色资料包含塞雷娅、赫默、白面鸮、梅尔、伊芙利特、麦哲伦、多萝西、缪尔赛思、淬羽赫默、星源和娜斯提；异格独立建档，不表示不同人物。此库为精选起始库，不宣称覆盖所有作品、时装或同人素材。

## 素材边界

图册区分官方发布、Wiki 游戏美术转存、Wiki 资料和社区设计项目。公开可访问不等于开放再分发；本次没有将任何第三方原图认定为可随主题公开发布。Wiki 的文字许可和代码仓库的 MIT 许可不自动覆盖原作标志、美术、字体或音频。

后续主题仍按 [设计决定](DECISIONS.md) 使用自行实现的 CSS / SVG 二维视觉。本次只建立参考库，不改变应用源码、依赖、公开演示或生产环境。素材下载与本地图册检查不替代原站音视频验播，也不构成未来主题版本的浏览器验收。
