/**
 * Helpers and constants shared by the conversation-header action and the sidebar
 * team board.
 *
 * They live in their own module because both surfaces import them — keeping them
 * inside either component would make that component the other's hidden
 * dependency, which is exactly how the previous single-file bundle drifted.
 */
import { useEffect, useState } from 'react'

/* TeamBoard 自制状态调色板：每个生命周期相位给一个独立可辨识的色相，
 * 与 StateDot 语义色（仅 5 值）解耦，供成员头像/状态点/分组点取色。
 *
 * 调色板按「紧迫度」分三带，明度是主载体、色相是次载体——
 * 面板要在一次扫视里回答「哪个我需要看」，所以亮而饱和的必须是
 * 需要动作的相位；running 这类「正在自己干活」的反而要压低，否则
 * 7 个满色点互相竞争，等于没有优先级。 */
export const TEAM_BOARD_STATUS_COLORS = {
	/* 注意力带：需要人介入，明度对齐同一档以免 unloaded 单独发飘 */
	failed: "oklch(64% 0.225 27)",
	unloaded: "oklch(74% 0.165 70)",
	/* 运动带：活着但无需介入 */
	running: "oklch(70% 0.155 152)",
	provisioning: "oklch(70% 0.125 205)",
	/* 静止带：近灰，「这里没事」——inactive 压到 52% 才是正确读数，
	 * released 靠色相 275 与它拉开，两个灰点仍可区分 */
	idle: "oklch(68% 0.055 248)",
	inactive: "oklch(52% 0.012 260)",
	released: "oklch(62% 0.018 275)"
};

/* 相对时间的「现在」。
 *
 * teamBoardRelative 最细的档位阈值是 60s（「刚刚」→「N 分钟前」），
 * 所以 30s 的步长就够了：任何一次跨档都不会晚于阈值出现 30s 以上。
 * 不 tick 的话「3 分钟前」会一直冻在那里，直到别的状态变更顺带触发
 * 重渲染——时间戳自己不会走，观感上就是「卡住了」。
 *
 * 用 interval 而不是 setTimeout 链：间隔固定，不依赖回调里的旧值，
 * 后台标签页被节流后回来也能立刻对齐（下一次 tick 仍会取 Date.now()）。 */
export const TEAM_BOARD_CLOCK_STEP = 3e4;

export function statusKey(status) {
	switch (status) {
		case "pending": return "status.pending";
		case "in_progress": return "status.in_progress";
		case "completed": return "status.completed";
		/* v8 ignore next -- Team views omit deleted task tombstones. */
		case "deleted": return "status.completed";
	}
}

export function memberStatusKey(status) {
	switch (status) {
		case "running": return "memberStatus.running";
		case "idle": return "memberStatus.idle";
		case "unloaded": return "memberStatus.unloaded";
		case "inactive": return "memberStatus.inactive";
		case "provisioning": return "memberStatus.provisioning";
		case "failed": return "memberStatus.failed";
		case "released": return "memberStatus.released";
	}
}

export function teamBoardStatusColor(status) {
	return TEAM_BOARD_STATUS_COLORS[status] ?? TEAM_BOARD_STATUS_COLORS.inactive;
}

/* 任务状态取色：复用成员调色板，ready 借 idle 蓝、blocked 借 failed 红、
 * completed 借 released 灰。 */
export function teamBoardTaskColor(status) {
	if (status === "in_progress") return TEAM_BOARD_STATUS_COLORS.running;
	if (status === "ready") return TEAM_BOARD_STATUS_COLORS.idle;
	if (status === "blocked") return TEAM_BOARD_STATUS_COLORS.failed;
	if (status === "completed") return TEAM_BOARD_STATUS_COLORS.released;
	return TEAM_BOARD_STATUS_COLORS.inactive;
}

/* 名字散列到 12 个色相，同队成员头像底色互不相同且对同一名字稳定。 */
export function teamBoardAvatarHue(name) {
	let hash = 0;
	for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
	return (hash % 12) * 30;
}

export function teamBoardAvatarText(name) {
	const text = name.trim();
	if (text === "") return "?";
	const units = [...text.toUpperCase()];
	/* 纯 ASCII 取首字母+次字母；含 CJK 时取头两个字符（姓名/词首）。 */
	if (units.length >= 2 && /[\u4e00-\u9fff]/u.test(text)) return units[0] + units[1];
	return units[0];
}

/* 成员卡片统计行：上下文占用%（token-meter 的 contextPressure 投影）、
 * 步数/输出 token（session-stats 投影）、相对时间（byId 摘要 updatedAt）。 */
export function teamBoardFormatTokens(value) {
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(value);
}

export function teamBoardContextPercent(pressure) {
	const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
	if (used === void 0 || !pressure?.contextWindow) return void 0;
	return Math.min(100, Math.round(used / pressure.contextWindow * 100));
}

/* 上下文占用色阶：绿(150°) → 黄(85°) → 红(27°)，按百分比插值。
 *
 * 这里必须独立于成员状态色算——进度条原先继承 --mtb-accent（成员相位色），
 * 而 idle/inactive/released 三个相位色的 chroma 只有 0.012~0.055，等于
 * 近灰，所以那三种成员看到的条是白的、完全没有告警语义。占用率是连续量，
 * 就该用连续色阶表达，和「成员是什么相位」无关。
 *
 * 色相走 oklch 的 h 通道插值（而不是 RGB 混色）：RGB 从绿混到红会经过
 * 脏褐色，oklch 保持明度/彩度恒定，只转色相，中间的黄是真黄。 */
export function teamBoardContextColor(percent) {
	const clamped = Math.max(0, Math.min(100, percent));
	/* 0~70% 绿→黄，70~100% 黄→红。分段让红色只在真正吃紧时才出现，
	 * 线性铺满会让 40% 就发黄、失去预警意义。 */
	const stops = clamped <= 70
		? { from: 150, to: 85, ratio: clamped / 70 }
		: { from: 85, to: 27, ratio: (clamped - 70) / 30 };
	const hue = stops.from + (stops.to - stops.from) * stops.ratio;
	const chroma = clamped <= 70 ? 0.14 + 0.03 * stops.ratio : 0.17;
	return `oklch(70% ${chroma.toFixed(3)} ${hue.toFixed(1)})`;
}

/* 绝对时间（本地时区）：`02-14 15:30`，跨年才补年份 `2025-02-14 15:30`。
 *
 * 为什么不显示年份是默认值：板上绝大多数任务都是当年的，而卡片信息栏
 * 只有 11px 宽的字号，四个字符的年份会挤掉后面的 Owner/状态。跨年任务
 * （翻旧账、跨年度项目）才补年份——那时"哪一年"才是关键信息。
 *
 * 不用 Intl/toLocaleString：宿主界面语言与系统区域可能不一致，而
 * `toLocaleString` 还受用户系统设置影响（有些区域会输出 2026/2/14
 * 下午3:30），在不同机器上长度差很多，卡片会被撑开或对不齐。
 * 手动拼固定宽度，跨机器表现一致。 */
export function teamBoardAbsolute(at, now) {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (value) => String(value).padStart(2, "0");
	const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	/* 用本地年份比较：跨年的判定必须与展示的时区一致，用 UTC 年会在
	 * 跨年夜前后差一天。 */
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return sameYear ? stamp : `${date.getFullYear()}-${stamp}`;
}

/* 任务从「接手」到「完成」的墙钟耗时。
 *
 * 算法：从 history 末尾往前扫，跳过所有 `in_progress` 条目，取**连续
 * in_progress 段落的第一个**（= 本次接手的时刻）；一旦遇到非 in_progress
 * 的状态就停——那说明任务退回过 pending（release/reopen），当前没有
 * 「进行中」的历史，不可算。
 *
 * 为什么不能简单取「最后一个 in_progress」或「第一个 claim」：
 * - 取第一个 claim：release/reopen 后重新接手的任务，会把中间闲置的
 *   时间也算进来（实测能差出一个数量级）。
 * - 取最后一个 in_progress：任务 release 回到 pending 后，那条旧的
 *   in_progress 仍在历史里，会被当成「还在跑」而算出一个一直增长的
 *   假耗时。
 * 从末尾往前找**连续段**同时避开了这两个坑。
 *
 * reassign 保持 in_progress，所以它会被跳过，起点落到更早的 claim——
 * 这符合「换个人接着做，不该重新计时」；而 reassign 若换了 owner，
 * 新 owner 的接手时刻确实是 reassign 那一刻，这一点由 claim 段落
 * 的起点表达（reassign 前若也是 in_progress，说明原本就有人在跑）。
 *
 * 终点：已完成取末条的 at；仍在进行中则取 now——进行中的任务显示
 * 「已耗时 12 分钟」比不显示有用，而 30s 的 tick 会让它自己走。
 */
export function teamBoardElapsed(task, now) {
	const history = task.history;
	if (history === void 0 || history.length === 0) return void 0;
	/* 从末尾往前，收集「连续的 in_progress / completed 段落」，取其中最靠前
	 * 的一条作为接手时刻；遇到 `pending` 就停。
	 *
	 * 三处细节都是必需的：
	 * - `completed` 要算进段落：已完工的任务末条是 complete，若把它当成
	 *   段落外状态，扫描第一步就截断，完工任务反而算不出耗时。
	 * - 段落里必须真的出现过 `in_progress`：否则那个起点只是别的状态
	 *   变更（例如历史被裁剪，只剩 create+complete），不是「接手」。
	 * - 末尾是 `pending` 直接返回 undefined：任务已 release/reopen 回到
	 *   待办，旧的 in_progress 仍在历史里，不能当成「还在跑」。
	 */
	let start;
	let sawInProgress = false;
	for (let index = history.length - 1; index >= 0; index--) {
		const status = history[index].status;
		if (status !== "in_progress" && status !== "completed") break;
		if (status === "in_progress") sawInProgress = true;
		start = history[index].at;
	}
	if (start === void 0 || !sawInProgress) return void 0;
	const end = task.status === "completed" ? history[history.length - 1].at : now;
	/* 时钟回拨（NTP 校正 / 手工改系统时间）会让差值为负——夹到 0，
	 * 显示「0 秒」而不是「-3 分钟」。 */
	return Math.max(0, end - start);
}

/* 毫秒 → `2小时13分` / `5分12秒` / `43秒`。
 *
 * 只显示两个最大非零单位：任务耗时跨度从秒到小时都有，三级全显示
 * （"0小时5分12秒"）在卡片上既长又有前导零噪音；而只显示最大单位
 * 会丢掉精度（"2小时"看不出是 2 小时 1 分还是 2 小时 59 分）。 */
export function teamBoardDuration(ms, t) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor(total % 3600 / 60);
	const seconds = total % 60;
	if (hours > 0) return `${t("board.durHour", { count: hours })}${t("board.durMin", { count: minutes })}`;
	if (minutes > 0) return `${t("board.durMin", { count: minutes })}${t("board.durSec", { count: seconds })}`;
	return t("board.durSec", { count: seconds });
}

export function teamBoardRelative(at, now, t) {
	const diff = Math.max(0, now - at);
	if (diff < 6e4) return t("board.relNow");
	if (diff < 36e5) return t("board.relMin", { count: Math.floor(diff / 6e4) });
	if (diff < 864e5) return t("board.relHour", { count: Math.floor(diff / 36e5) });
	return t("board.relDay", { count: Math.floor(diff / 864e5) });
}

export function useTeamBoardNow() {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), TEAM_BOARD_CLOCK_STEP);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/* 该成员「运行中或最近」的任务：优先 in_progress，其次 pending，
 * 最后取已完成的（作为「上一个任务」）。 */
export function teamBoardMemberTask(tasks, memberId) {
	let fallback;
	for (const task of tasks) {
		if (task.owner !== memberId) continue;
		if (task.status === "in_progress") return task;
		if (task.status === "pending" && fallback === void 0) fallback = task;
		if (task.status === "completed") fallback = task;
	}
	return fallback;
}

/* lead 解析兜底链：byId.subagent 地址缺失时（队友侧快照常见），
 * 再试 binding 路径，最后由成员名单反查（parentSessionId 匹配）。 */
export function teamBoardLeadId(sessionId, list) {
	const parent = list.byId[sessionId]?.subagent?.address?.parentSessionId;
	if (parent !== void 0) return parent;
	const binding = list.binding?.(sessionId)?.session.getSnapshot().subagent?.address?.parentSessionId;
	if (binding !== void 0) return binding;
	for (const projection of Object.values(list.projectionsBySession)) {
		const members = projection?.values.agentTeam?.members;
		if (members?.some((member) => member.id === sessionId)) {
			const own = list.byId[sessionId];
			/* 自己在某个 team 投影的成员名单里出现——但投影键才是 lead，
			 * 需要用 projection 所属 session；用闭包键扫描。 */
			for (const [leadId, candidate] of Object.entries(list.projectionsBySession)) {
				if (candidate === projection && leadId !== sessionId) return leadId;
			}
			void own;
		}
	}
	return sessionId;
}

export function teamBoardLastDefined(previous, next) {
	return next === void 0 ? previous : next;
}

export function taskDotState(task) {
	switch (task.status) {
		case "pending": return task.ready ? "idle" : "warning";
		case "in_progress": return "ongoing";
		case "completed": return "done";
		/* v8 ignore next -- Team views omit deleted task tombstones. */
		case "deleted": return "idle";
	}
}
