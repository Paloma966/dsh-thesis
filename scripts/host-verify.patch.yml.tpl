# dsh-thesis 宿主装载验证用的**临时**补丁层（由 scripts/host-verify.mjs 生成，用完即删）。
#
# 为什么不用仓库里的 cordis.patch.yml：那一行按包名 `dsh-thesis` 引用，要求引擎
# 从 profile 的 node_modules 解析到本仓库——而"把包装进 profile"会改动
# `$DSH_HOME/profiles/web`（工作区之外，本会话的策略不允许）。
# 这里改用**指向本仓库的绝对路径模块说明符**，从而在完全不接触用户 profile 的
# 前提下，让真实 dsh 引擎去解析、加载并装配本插件。
- insert:
    - id: paper
      name: REPO_PATH
