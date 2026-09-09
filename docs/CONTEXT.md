# Quota Dashboard

这是一个聚合多个 AI 服务额度信息的领域，用于让用户比较订阅额度、用量和重置周期。

## Language

**Provider**:
提供额度信息的外部 AI 服务。Provider 是额度来源的分类，不等同于用户凭证或展示账号。
_Avoid_: 平台、账号

**Credential（凭证）**:
用户用于访问一个 Provider 额度信息的授权材料，可能包含秘密材料和非秘密标识。
_Avoid_: 密钥、账号

**Quota Window（额度窗口）**:
Provider 在一个固定周期内统计用量的额度范围，例如五小时、每周或每月窗口。
_Avoid_: 配额、周期额度

**Usage Percentage（用量百分比）**:
额度窗口中已经使用的额度占该窗口总额度的比例，范围为 0 到 100。
_Avoid_: 剩余百分比

**Reset Time（重置时间）**:
额度窗口恢复或重新开始统计的时间点。
_Avoid_: 到期时间

**Quota Snapshot（额度快照）**:
面板在某一时刻为一个展示账号保存的 Provider 额度状态，包括套餐、额度窗口和数据来源。
_Avoid_: 余额、账单

**Display Account（展示账号）**:
面板中展示一个 Quota Snapshot 的对象。一个 Credential 可以对应一个或多个展示账号，展示账号不代表新的授权材料。
_Avoid_: 用户、凭证

**Plan（套餐）**:
Provider 为 Credential 或展示账号标识的订阅档位或服务计划。
_Avoid_: 等级、模型

**Entitlement（权益类型）**:
Provider 赋予 Credential 的服务权益类别，表示其可使用的产品范围和额度形式。
_Avoid_: 鉴权、余额
