# 枢机车厢 · 自动化编程

玩家在 **枢机车厢** 中央设备按交互键打开全屏控制台，为任一节车厢编写规则。

## 核心原则

1. **统一优先级列表**  
   控制台只有一段 **规则** 列表。所有规则（持续 / 瞬时）按 **从上到下** 优先级从高到低。不再拆「瞬时触发」独立段。

2. **行位置 = 优先级**  
   拖拽或 ↑ / ↓ 调整优先级（越靠上越高）。瞬时规则在触发当帧仍参与同一优先级队列。

3. **冲突域：同 tick 只执行最高优先级匹配项**  
   同一车厢、同一帧内，若多条规则都「应开火」且行为属于同一冲突域，只执行列表更靠上的那条。无冲突域的行为可并行。

   | 冲突域 id | 行为 | 说明 |
   |-----------|------|------|
   | `ammo` | `select_ammo`（含旧 `turret_ammo`） | 弹种 / 弹链互斥 |
   | `lock` | `lock_unit` | 锁定目标互斥 |
   | `alert` | `send_alert` | 警报 / Toast 防刷屏 |
   | `speed` | `set_speed` | 目标车速互斥（驾驶台自动驾驶接通时规则改速被跳过） |
   | `var:<名>` | `set_var` | 同一变量名互斥；不同变量可并行 |
   | （无） | `noop` 等 | 不参与互斥 |

4. **一行 = 条件 → 行为**  
   `【触发模式】` + `【条件】`（可带参数）→ `【行为】`（可带参数）。触发模式为行属性，可在编辑向导顶部小切换。

5. **触发模式**
   - **持续判定**（`while`）：每帧检查，条件为真就执行（类似 `while`）。
   - **瞬时触发**（`edge`）：仅在条件从假变为真的那一帧执行一次（类似事件边沿）。

6. **默认触发：目录旗标自动选**  
   条件 / 行为可带 `preferEdge` / `preferWhile`。新建或改条件/行为时（尚未手动改过触发）：
   - 任一侧 `preferWhile` → `while`（优先于 edge）
   - 否则任一侧 `preferEdge` → `edge`
   - 否则 → `while`  
   玩家仍可在向导顶部切换覆盖。编辑已有规则时保留原 trigger，不自动改写。

   | 条目 | 旗标 | 意图 |
   |------|------|------|
   | 条件 `turret_lock_kind`（炮塔当前锁定） | `preferEdge` | 锁定类型**变为**某类时才动 |
   | 条件 `car_on_fire`（车厢着火） | `preferWhile` | 着火期间持续报警 |
   | 条件 `platform_ahead` / `at_platform` | `preferWhile` | 月台态持续判定 |
   | 行为 `send_alert` | `preferEdge` | 警报宜单次，避免每帧刷 |
   | 行为 `select_ammo` | `preferWhile` | 条件成立期间保持自动装载（同 pattern 不重置游标；盖过锁定类 preferEdge） |
   | 行为 `lock_unit` 等 | （无） | 如「射程内→锁最近」保持持续 |

7. **玩家编辑步骤**（参数一律在选项行内联）
   1. 选择条件（与当前车厢不匹配的不出现；参数同行内联）  
   2. 选择行为（同上）  
   顶部可切换持续 / 瞬时（自动默认，可覆盖）。

## 比较符（条件共用）

比较类条件统一带 `params.op` + 阈值（或变量名）。可选：

| `op` | UI 显示 | 悬浮提示 |
|------|----------|----------|
| `eq` | `=` | 等于 |
| `neq` | `!=` | 不等于 |
| `gt` | `>` | 大于 |
| `lt` | `<` | 小于 |
| `gte` | `>=` | 大于等于 |
| `lte` | `<=` | 小于等于 |

求值：`LpAutoProgramCatalog.compare(a, op, b)`（`LpAutoSensors.evaluateCondition` 调用）。  
旧存档/剪贴板缺 `op` 时，加载迁移补默认：`enemy_hp_below` / `ammo_below` / `fuel_below` → `lt`；`speed_above` / `var_gt` → `gt`（条件 **id 保留旧名** 兼容）。

| 条件 id | 标签 | 默认 op | 其它 params | cars |
|---------|------|---------|-------------|------|
| `enemy_hp_below` | 敌方生命值 | `lt` | `hp` | guard, huigui |
| `ammo_below` | 弹药剩余量 | `lt` | `count` | guard |
| `fuel_below` | 锅炉燃料 | `lt` | `level` | power |
| `speed_above` | 车速绝对值 | `gt` | `speed` | 全车 |
| `var_gt` | 变量 | `gt` | `name`, `value` | 全车 |
| `compare_values` | 数值比较 | `gt` | `leftKind`/`leftNum`/`leftVar` + `rightKind`/`rightNum`/`rightVar`（任一侧为数值或变量） | 全车 |
| `targets_in_view` | 小型目标集群数 | `gte` | `count`（默认 1） | huigui |
| `large_targets_in_view` | 大型目标数 | `gte` | `count`（默认 1） | huigui |
| `platform_ahead` | 前方有月台 | — | （无；布尔） | power |
| `at_platform` | 位于月台 | — | （无；布尔） | power |

`platform_ahead` / `at_platform` 读 `LpAutoSensors.getPlatformSensor()`（`platformAhead` / `atPlatform` / `distanceAhead`）。月台未实现前 stub 恒假、`distanceAhead=null`；调试：`setPlatformStub({ platformAhead, atPlatform, distanceAhead })`。有限距离 ≤ `PLATFORM_AHEAD_DIST`（800）时亦可视为前方有月台。

`compare_values` 行内 UI：`[数值|变量] [值] [比较符] [数值|变量] [值] 时`；求值经 `Catalog.compare`，变量侧用 `LpAutoSensors.readProgramVar`。`var_gt` 仍保留（变量 vs 固定阈值的快捷形式）。

`targets_in_view`（及别名 `small_target_clusters_in_view`）计数与传感器「小型目标集群数」同源：`LpAutoSensors.countSmallTargetClustersInRange('huigui')`（绘轨探测射程；邻域 300u、簇≥2、按 ground/air 分桶，同雷达密度云）。`large_targets_in_view` 与「大型目标数」同源（`kind=large` 等个体；当前无大型怪时为 0）。

## 玩家参数（变量）

控制台左侧分两块：

1. **全局变量** — 整列车共用  
2. **车厢局部变量** — 随上方选中的车厢切换；各车独立一份（目录可按 `cars` 过滤；武装车另有只读传感器）

| 变量 | id | 作用域 | 车厢 | 默认可写 | 用途 |
|------|-----|--------|------|----------|------|
| 撤退速度 | — | 全局 | — | ✓ | `设置速度 $撤退速度` |
| 冲锋速度 | — | 全局 | — | ✓ | 前进冲锋 |
| 计数器 | `counter` | 车厢局部 | 全车 | ✓ | 通用整数计数（类似 py `counter`） |
| 锁定计数器 | `lock_counter` | 车厢局部 | 全车 | ✓ | 锁定相关自增计数 |
| 范围内目标数 | `targets_in_range` | 车厢局部 | guard | 只读传感 | 卫兵武器射程内目标个体数（`LpAutoSensors.tick`） |
| 大型目标数 | `large_targets_in_range` | 车厢局部 | huigui | 只读传感 | 绘轨探测射程内大型目标个体数 |
| 小型目标集群数 | `small_target_clusters_in_range` | 车厢局部 | huigui | 只读传感 | 绘轨探测射程内小型目标集群数（同雷达密度云） |
| 剩余弹药数 | `ammo_remaining` | 车厢局部 | guard | 只读传感 | 弹药箱剩余（同 `LpGuardTurret.ammoCount` / 状态栏「弹药 N」） |

表达式行为里可用 `$变量名`，例如：`$计数器 + 1`。只读传感器不可在控制台改；每帧由运行时覆盖。

**不作为玩家参数：** 炮塔瞄准的动态提前量 / 角速度修正。自动化开火时由 `LpGuardTurret` 内置处理（`getAimLeadScale`、`TURN_RATE`），无需在控制台调节。旧剪贴板里若仍带这两个键，导入时会丢弃。

## 默认规则（全车库存）

每节车厢程序默认带一行 **持续判定**：

`[持续] 若 车厢着火 → 发送警报（{短名}车厢着火！）`

| carId | 警报文案 |
|-------|----------|
| `guard` | 卫兵车厢着火！ |
| `storage` | 仓储车厢着火！ |
| `power` | 动力车厢着火！ |
| `huigui` | 绘轨车厢着火！ |
| `shuji` | 枢机车厢着火！ |

- 结构：`trigger: "while"`，`condition.id: "car_on_fire"`，`action.id: "send_alert"`，`action.params.message` 如上；稳定 `id` 形如 `stock_fire_alert_{carId}`。
- **种子**：全新程序 / 某车规则为空 → 写入该默认行。
- **迁移**：加载/导入时若该车尚无「同 condition.id + action.id」的着火警报，则插入（不覆盖其它自定义规则）；已存在则不去重以外的修改。
- 玩家可改消息或删行；导出/导入仍走同一规范化路径，空白车会再补默认。
- `car_on_fire.preferWhile` 覆盖 `send_alert.preferEdge`，故新建同类规则仍默认持续。

## 范例对照（`程序代码范例.txt`）

锁定目标统一为一条行为 **锁定单位**，用下拉选择目标类型（最近 / 最远 / 生命值最高·最低 / 护甲最高·最低）。**没有**单独的「控制炮塔角度」行为；锁定后炮塔会自动瞄准提前量位置并攻击。

```text
全车默认:
  - 持续 / 车厢着火 → 发送警报 "{短名}车厢着火！"

炮塔规则（建议写在「卫兵」车厢；列表顺序即优先级）:
  - 持续 / 射程内存在敌方 → 锁定单位（最近）
  - 瞬时 / 敌方生命值 < 10 → 选择弹种/弹链（穿甲 AP）
  - 持续 / 射程内存在敌方 → 设置 $锁定计数器 = $锁定计数器 + 1
  - 瞬时 / $锁定计数器 > 10 → 锁定单位（生命值最低）；再把计数器清零（可拆两行）

卫兵规则（弹药告急）:
  - 瞬时 / 弹药剩余 < 3 → 发送警报 "弹药告急！"

动力车厢规则:
  - 持续 / 锅炉燃料 < 20 → 设置速度 $撤退速度
```

**自动驾驶**不在枢机目录：在**动力驾驶台**顶栏「离开」左侧开关接通。接通后 `LpAutoAutopilot` 独占节流（满档巡航 → `platformAhead` 按 `distanceAhead` 降档 → `atPlatform` 停车 → 汽笛上升沿且全员在车厢时 `LpPlatform.beginDepart` 驶向下站）；有人仍在月台则 toast「还有玩家在月台上」并保持停车。关闭开关交还手动拉杆（不改当前档）。制动阀仍可手动急刹。汽笛：下拉驾驶台右上角绳索至「鸣」。枢机 `set_speed` 在自动驾驶接通时不执行。

计数器自增必须用 **持续判定**，否则瞬时触发永远到不了阈值。  
若两条 `lock_unit` 同帧都匹配，只执行更靠上的那条（冲突域 `lock`）。

## 车厢能力过滤（条件 / 行为）

目录项带 `cars: [...]`（`null` = 全车）。向导只列出当前选中车厢可用的项；已保存规则不受影响（列表仍可读摘要）。

| 条件 / 行为 | guard 卫兵 | storage 仓储 | power 动力 | huigui 绘轨 | shuji 枢机 | artillery 火炮* |
|-------------|:----------:|:------------:|:----------:|:-----------:|:----------:|:---------------:|
| 射程内存在敌方 / 敌方生命值（比较） | ✓ | | | ✓ | | |
| 炮塔当前锁定（分类） | ✓ 无/地/空 | | | | | ✓ 无/大型 |
| 弹药剩余量（比较） | ✓ | | | | | |
| 锅炉燃料（比较） | | | ✓ | | | |
| 前方有月台 / 位于月台 | | | ✓ | | | |
| 视野内目标数（比较） | | | | ✓ | | |
| 车速绝对值 / 变量（比较） / 车厢着火 / 总是 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓* |
| 锁定单位 | ✓ | | | ✓ | | |
| 选择弹种/弹链 | ✓ | | | | | |
| 车厢设置速度 | | | ✓ | | | |
| 设置变量 / 发送警报 / 无操作 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓* |

\* `artillery` 车厢尚未编入列车；条件已按火炮武装预留，卫兵 UI 仅显示机炮三项。

## 分享：复制 / 导入剪贴板

控制台顶栏：

- **复制到剪贴板**：导出**整份**程序（全部车厢规则 + 玩家参数）为纯文本 JSON，可粘贴到聊天 / Discord 发给其他玩家。
- **从剪贴板导入**：读取剪贴板文本，按 `kind` 分支：
  - `liminal-auto-program` → **覆盖**当前整份程序；成功后出现 **撤销导入** 横幅（约 25 秒，或下次改规则/变量前），可恢复导入前快照。再次覆盖导入会替换旧快照。
  - `liminal-auto-rule` → **追加**一条规则到**当前选中车厢**列表末尾，不改变量、不碰其它车厢/其它规则。
- 校验失败会提示原因。若浏览器拒绝 `clipboard.readText()`，会弹出文本框让你手粘贴再导入。

每条规则行工具栏（↑↓ 旁）另有 **复制**：只复制该条规则（`kind: liminal-auto-rule`）。Toast：`已复制规则` / 追加成功 `已添加规则`。

写入剪贴板失败时仍会下载 `liminal-auto-program.json` / `liminal-auto-rule.json` 作为兜底。

## 数据格式（分享 JSON）

### 整份程序

```json
{
  "kind": "liminal-auto-program",
  "version": 3,
  "vars": { "撤退速度": -40, "冲锋速度": 60 },
  "varsByCar": {
    "guard": {
      "计数器": 0,
      "锁定计数器": 0,
      "范围内目标数": 0,
      "剩余弹药数": 0
    },
    "huigui": {
      "计数器": 0,
      "锁定计数器": 0,
      "大型目标数": 0,
      "小型目标集群数": 0
    }
  },
  "beltsByCar": {
    "guard": [
      { "id": "pb_…", "slots": ["t", "t", "ap"] }
    ]
  },
  "rulesByCar": {
    "guard": [
      {
        "id": "r_…",
        "trigger": "while",
        "condition": { "id": "enemy_in_range", "params": {} },
        "action": { "id": "lock_unit", "params": { "target": "nearest" } },
        "note": ""
      },
      {
        "id": "r_…",
        "trigger": "edge",
        "condition": { "id": "enemy_hp_below", "params": { "op": "lt", "hp": 10 } },
        "action": { "id": "select_ammo", "params": { "target": "type:ap" } },
        "note": ""
      }
    ]
  }
}
```

### 单条规则

```json
{
  "kind": "liminal-auto-rule",
  "version": 1,
  "carId": "shuji",
  "rule": {
    "id": "r_…",
    "trigger": "while",
    "condition": { "id": "car_on_fire", "params": {} },
    "action": { "id": "send_alert", "params": { "message": "枢机车厢着火！" } },
    "note": ""
  }
}
```

- `kind`: `liminal-auto-program`（整份覆盖）或 `liminal-auto-rule`（单条追加）  
- `version`: 程序当前为 `3`（+`beltsByCar`）；仍接受 v2；单条规则为 `1`；仍接受旧版扁平 `vars`（局部键会迁移进各车）  
- `vars`: 全局变量；`varsByCar[carId]`: 该车厢局部变量  
- `beltsByCar[carId]`: 程序弹链数组 `{ id, slots[] }`；`slots.length` = 该车 `LpArmedAmmo.slotsPerBelt`；组数 ≤ `maxBelts`；仅 `supportsBelts` 车厢有意义  
- `rulesByCar[carId]`: **统一优先级数组**（下标越小越高）。加载旧存档时一次性将旧「while 段 + edge 段」拼接为该数组（while 在前、edge 在后，段内相对顺序不变）；之后编辑不再按 trigger 重排  
- 单条包内 `carId` 为参考；导入时以控制台**当前选中车厢**为准，并重新分配 `rule.id`  
- `trigger`: `while` | `edge`  
- `action.id` = `lock_unit` 时，`params.target` 为：`nearest` | `farthest` | `highest_hp` | `lowest_hp` | `highest_armor` | `lowest_armor`  
- `action.id` = `select_ammo` 时，`params.target` 为 `type:<ammoId>`（如 `type:ap`）或 `belt:<programBeltId>`；运行时写入 `LpArmedAmmo` 内存自动装载 `autoByCar`（不改本机弹药箱弹链）  
- 旧版 `lock_nearest` / `lock_lowest_hp` 等会在加载/导入时自动迁成 `lock_unit`；旧 `turret_ammo` 迁成 `select_ammo`  
- 条件/行为带 `cars: ['guard', 'huigui', …]` 时仅这些车厢在向导中可选（`null` 表示全车）  
- 导入时丢弃已退役键：`动态提前量`、`角速度修正`  
本地持久化键：`lp-auto-program-v1`。覆盖导入的撤销快照仅存内存，不写 localStorage。

## 扩展

- 新条件/行为：改 `LpAutoProgramCatalog`。比较类条件复用 `COMPARE_OPS` / `compareOpParam` / `compare`；左右皆可数值或变量时用 `numOrVarParam`（扁平 `*Kind`/`*Num`/`*Var`）+ `compare_values`。边沿偏好设 `preferEdge` / `preferWhile`；冲突域登记在 `ACTION_CONFLICT_DOMAINS` / `conflictDomainForAction`。  
- 向导 UI：条件/行为的**全部** params 在选项行内联（`lp-auto-console`）；`numOrVar` / `static` 类型同文件渲染；触发模式为顶部小切换，不再独立一步。  
- 默认着火警报：`LpAutoProgramCatalog.defaultRulesForCar` / `ensureStockRules`；`LpAutoProgram` 在 `emptyProgram` / `normalizeProgram` 中种子与迁移。  
- 运行时：主循环 `LpAutoSensors.tick` 后 `LpAutoExecutors.tick`；`rulesForRuntime` 返回统一数组；按序求值，冲突域 claim 后跳过低优先级；edge 上升沿仍更新 `edgePrev`。控制台打开时暂停调度。  
- 条件求值：`LpAutoSensors.evaluateCondition(cond, carId)`；比较类走 `Catalog.compare`；`car_on_fire` 经 `isCarOnFire` / `setCarOnFire` 钩子，着火系统未接入前恒为假。  
- 月台 stub：`getPlatformSensor` / `setPlatformStub` / `platform_ahead` / `at_platform`；正式月台接入前恒假。  
- 自动驾驶：驾驶台开关 → `LpAutoAutopilot.setEngaged`；主循环 `LpAutoExecutors.tick` 末尾 `LpAutoAutopilot.tick`（接通时写节流；与枢机规则无关，控制台打开时仍跑）。停靠态汽笛上升沿武装 `WHISTLE_DEPART_DELAY_SEC`（3s）等待，期满再 `canDepart` / `beginDepart`（全员在车厢则驶向下站，否则 toast「还有玩家在月台上」）；离站或关自动驾驶则取消等待。  
- `select_ammo`：`LpAutoExecutors.executeAction` → `LpArmedAmmo.applyAmmoSelection` 写入内存 `autoByCar`（自动装载；不改弹药箱本机弹链）。卫士无人开火：`tryFireTurrets` → `peekFireTypeId('guard')` / `advanceFireCursor('guard')` → `spawnProjectile({ ammoType })`（T=绿曳光）。入座 `activate` 清 `autoByCar` 并拒绝再写；离席 `deactivate` 重置 ammo 域边沿闩并允许再写。持续规则同 pattern 保留 cursor。  
- 程序弹链编辑：卫兵侧栏 `LpAutoProgramBelts`（UX 对齐弹药箱底栏；槽长/组数取车厢配置）。  
- 传感器局部变量：`LpAutoSensors.tick` → `applySensorVars` 写入卫兵 `范围内目标数` / `剩余弹药数`，绘轨 `大型目标数` / `小型目标集群数`（不刷 localStorage）。  
- 加载迁移：`migrateConditionParams` 补 `op`；`migrateAction` 迁 `turret_ammo`；`migrateRule` 仍迁旧 `lock_*`；`normalizeRulesOrder` 仅在 `normalizeProgram` 时把旧两段拼成统一列表。  
- API：`LpAutoConsole.open()` / `.close()`；`LpAutoProgram.getBelts` / `setBelts` / `toShareText()` / `.importShareText(raw, { targetCarId })` / `.undoLastImport()`；交互点 `openAutoConsole`。
