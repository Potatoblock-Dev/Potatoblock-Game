# 压力（Pressure）

本机「压力」资源：影响准确度与（预留）作业效率，并驱动边缘色差。实现：`static/js/lp-pressure.js`；HUD：`lp-hud-vitals.js`。濒死/死亡见 `lp-player-death.js`。

## 联机模型

| 项 | 选择 |
|--|--|
| 权威 | **每人本地**：小怪同车 / 受击 / 开火 / 闲置只改本机压力 |
| HUD 同步 | 经 `pose.pressure`（及可选 `pose.hp` / `lifeState`）透传 |
| 同车上限 160 | 用远端实体世界坐标 + `LiminalCarriageSpec.carriageAt` 判定是否同车厢有队友 |
| 色差 / 准确度 | **仅本机**压力 |

HP 伤害仍主要是本地小怪逻辑；`pose.hp` / `lifeState` 为队友条与濒死同步，**非**服务端权威生命。

## 上限

| 条件 | 有效上限 |
|--|--|
| 独自（同车厢无其他在线玩家） | **200** |
| 同车厢有 ≥1 名在线队友 | **160** |

**钳制策略（硬帽）：** 任意增益与每帧 `tick` 都将压力 `clamp` 到当前有效上限。

## 来源 / 汇

| 事件 | 条件 | 变化 | 备注 |
|--|--|--|--|
| 闲置衰减 | 无有效动作 ≥ **3.5s** | −**4**/秒 | `noteAction` |
| 同车小怪 | 压力 **&lt; 20** 且同车舱内有怪 | **+5** | 冷却 **2.5s** |
| 被怪打中 | 触碰命中 | **+5** | 无条件 |
| 同车开火 | 枪口与本机同车厢且压力 **&lt; 20** | **+10** | 余晖降至 20 |
| **附近友军最终死亡** | 远端 `lifeState`→`dead` 且 `deathCause≠redeploy`，`|Δx|≤` 加压半径 | **+100** | **仅计时耗尽等最终死亡**；进入濒死不加 |
| **附近友军重新部署** | 远端 `dead` 且 `deathCause=redeploy`，同半径 | **+20** | 濒死长按放弃→仓储重生 |
| 急救箱复活（被救） | 本机从濒死被救起 | **濒死时压力 +80** | 钳到有效上限；**附近友军不加** |
| 急救箱复活（救人） | 本机成功救起队友 | 若压力 **&gt;20**：最多 **−20**，不低于 **20** | 例 35→20、25→20、18 不变 |

### 附近友军加压三态（必须分清）

| 远端事件 | 附近本机压力 |
|--|--|
| 进入濒死 `downed` | **+0** |
| 重新部署 `dead` + `deathCause=redeploy` | **+20** |
| 计时耗尽等最终死亡 `dead`（非 redeploy） | **+100** |
| 被急救箱复活回 `alive` | **+0** |

加压半径：`LpPlayerDeath.allyDeathRadius()` ≈ **1.5 × `COUPLER_JOIN_OFFSET`**（约 1.5 节车厢间距；与听力 `REF_DIST≈1200` 同量级、略宽）。「倒下时附近有队友 → 濒死 15s」用同一半径。

## 濒死 / 复活 / 重生（摘要）

| 项 | 规则 |
|--|--|
| 启用濒死 | 联机且存在至少一名在线远端队友；否则 HP≤0 直接最终死亡 |
| 濒死时长 | 默认 **10s**；倒下瞬间半径内有队友 → **15s** |
| 重新部署 | 濒死时长按空格（触屏开火键）**3s** → `dead` + 仓储重生流程；附近友军 **+20** |
| 急救箱复活 | 瞄准濒死队友开火，消耗**整箱急救箱**（`first_aid_kit`）；HP = **maxHP×20%**；被救压力 = 濒死时压力 **+80**。持续回血用**医疗箱**（`medkit`）。 |
| 最终死亡重生 | 死后 **3s** 再按任意键/鼠标左右键 → 最近仓储走道中心，满血 |

## 效果带 / 色差 / HUD

（与既有一致：效果带 20/25；色差 p&gt;150；本机 + 队友条。濒死时本机 HP 条改为**白色倒计时**，屏幕边缘泛白。）

## API（`window.LpPressure`）

| 成员 | 含义 |
|--|--|
| `noteAllyDeathNearby(x)` | 附近最终死亡 +100 |
| `noteAllyRedeployNearby(x)` | 附近重新部署 +20 |
| `noteAction` / `noteMobHit` / `setPressure` / `tick` | 既有钩子 |

## 常量对照

```
MAX_ALONE=200  MAX_WITH_TEAMMATE=160
ALLY_DEATH_DELTA=100  ALLY_REDEPLOY_DELTA=20
DOWNED_DURATION_DEFAULT=10  DOWNED_DURATION_NEAR_ALLY=15
REDEPLOY_HOLD=3  REVIVE_HP_FRAC=0.2  REVIVE_PRESSURE_ALLY=+80
RESPAWN_INPUT_DELAY=3
```
