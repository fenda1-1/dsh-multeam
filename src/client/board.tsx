// @ts-nocheck — migrated verbatim from the verified bundle; types are tightened incrementally.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { createPortal } from 'react-dom'
import { createPortal as _createPortal } from 'react-dom'
import {
	IconChevronDownOutlineRegular,
	IconUsersOutlineRegular,
	IconUserOutlineRegular,
	MarkdownText,
	StateDot,
	Tag,
	Tooltip,
	extractMarkdownPlainText,
	useAnchoredPosition,
	useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { action, board } from './styles.js'
import {
	TEAM_BOARD_STATUS_COLORS,
	memberStatusKey,
	statusKey,
	taskDotState,
	teamBoardAbsolute,
	teamBoardAvatarHue,
	teamBoardAvatarText,
	teamBoardContextColor,
	teamBoardContextPercent,
	teamBoardDuration,
	teamBoardElapsed,
	teamBoardFormatTokens,
	teamBoardLastDefined,
	teamBoardLeadId,
	teamBoardRelative,
	teamBoardStatusColor,
	teamBoardTaskColor,
	useTeamBoardNow,
} from './shared.js'

//#region lib/types/client/TeamBoard.js
/**
* Right-sidebar "多人团队" tab: the lead Session's `agentTeam` projection
* rendered as two switchable groups — members by lifecycle status and tasks
* by board status.
*/
function teamBoardMemberStatus(member, running) {
	/* member.status 是 TeamMemberView 透出的四值 running/idle/unloaded/inactive；
	 * 非 active 成员回落到 phase，running 仅作 status 缺省兜底——与 TeamMemberRow 一致。 */
	if (member.phase !== "active") return member.phase;
	return member.status ?? (running === true ? "running" : "inactive");
}
function teamBoardTaskGroup(task) {
	if (task.status === "deleted") return null;
	if (task.status === "completed") return "completed";
	if (task.status === "in_progress") return "in_progress";
	if (task.ready) return "ready";
	return "blocked";
}
/**
* `sidebar.right.pane.tab` 不带 conversation 框架的 `useSessions` hook，
* 直接用 ctx.sessions.list 的 subscribe/getSnapshot 自建 selector hook。
*/
function useTeamBoardSessions(sessions) {
	return useSyncExternalStore(
		useCallback((listener) => sessions.list.subscribe(listener), [sessions]),
		useCallback(() => sessions.list.getSnapshot(), [sessions])
	);
}
/* 成员卡片上的「当前任务」摘要行、任务时间线面板共用的视口边距。 */
const TEAM_BOARD_POPOVER_MARGIN = 8;
/* 时间线悬浮面板里正文预览的字数。取 42：面板最宽 240px、字号 10px，
 * 一行约能排 42 个全角字符，正好一行多一点——再多面板就变成一块了，
 * 而这块面板的职责是「认出是哪条消息」，不是替代阅读正文。 */
const TEAM_BOARD_RAIL_PEEK_CHARS = 42;
function TeamBoardMemberRow({ member, sessionId, sessions, openTeammate, onError, t, taskList, task, updatedAt, selected, onSelect, onOpenTask }) {
	const list = useTeamBoardSessions(sessions);
	const now = useTeamBoardNow();
	const running = list.byId[member.id]?.running;
	const status = teamBoardMemberStatus(member, running);
	const isCurrent = member.id === sessionId;
	const inert = isCurrent || status === "failed" || status === "provisioning";
	const name = member.name ?? member.id;
	const model = list.projectionsBySession[member.id]?.values.modelSelection?.next?.model;
	const pressure = list.projectionsBySession[member.id]?.values.contextPressure;
	const stats = list.projectionsBySession[member.id]?.values.sessionStats;
	const contextPercent = teamBoardContextPercent(pressure);
	const accent = teamBoardStatusColor(status);
	const classes = [board.member];
	if (isCurrent) classes.push(board.memberCurrent);
	if (selected) classes.push(board.memberSelected);
	const hasTasks = taskList.length > 0;
	/* 任务区展开态。默认收起：卡片只露一个摘要任务（标题+一行信息），
	 * 完整清单是「要看时才展开」的第二层——把全部任务平铺在默认态会让
	 * 成员面板被少数任务多的成员占满。 */
	const [expanded, setExpanded] = useState(false);
	return jsxs("div", {
		className: classes.join(" "),
		style: { ["--mtb-accent"]: accent },
		/* 整卡点击切换选中（不是跳转）。键盘可达：role=button + Enter/Space。
		 * 「当前会话」的卡是跳转目标本身，选中它没有筛选意义，所以不参与。 */
		...(isCurrent ? {} : {
			role: "button",
			tabIndex: 0,
			"aria-pressed": selected === true,
			/* 选中态以「名字」为键，不是 id：对话记录按 message.from/to 过滤、
			 * 任务高亮按 ownerName 比对，两处 wire 视图只携带名字，id 在这里
			 * 无法参与任何下游匹配。ChatMemberPanel 从消息里推导出的键也只能
			 * 是名字，两处面板必须共用同一套键，否则选中后筛不出东西。 */
			onClick: () => onSelect(name),
			onKeyDown: (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onSelect(name);
			}
		}),
		children: [
			selected ? jsx("span", { className: board.memberCheck, "aria-hidden": true, children: "✓" }) : null,
			jsx("span", {
				className: board.avatar,
				/* 头像承担「是谁」，状态点承担「什么状态」——两者同卡并存，
				 * 所以头像压到低饱和，避免它的名字色相当成第二个状态信号。 */
				style: { ["--mtb-accent"]: `oklch(65% 0.07 ${teamBoardAvatarHue(name)})` },
				children: teamBoardAvatarText(name)
			}),
			jsxs("span", {
				className: board.memberText,
				children: [
					jsx("span", {
						className: board.memberName,
						children: name
					}),
					jsx("span", {
						className: board.memberMeta,
						children: [
							jsx("span", { className: board.statusDot, style: { background: accent } }),
							t(memberStatusKey(status)),
							model !== void 0 ? ` · ${model}` : ""
						]
					}),
					(contextPercent !== void 0 || (stats !== void 0 && stats.steps > 0) || updatedAt !== void 0) && jsxs("span", {
						className: board.memberStats,
						children: [
							contextPercent !== void 0 ? jsxs("span", {
								className: board.ctxPill,
								style: {
									["--mtb-ctx"]: String(contextPercent),
									["--mtb-ctx-color"]: teamBoardContextColor(contextPercent)
								},
								title: t("board.contextUsage", { percent: contextPercent }),
								children: [
									jsx("span", { className: board.ctxBar, children: jsx("span", { className: board.ctxFill }) }),
									jsxs("span", { className: board.ctxNum, children: [contextPercent, "%"] })
								]
							}) : null,
							stats !== void 0 && stats.steps > 0 ? jsxs("span", {
								className: `${board.statPill} ${board.statSteps}`,
								children: [
									jsx("span", { className: board.statGlyph, children: "⏱" }),
									stats.steps,
									` ${t("board.unitSteps")}`
								]
							}) : null,
							stats !== void 0 && stats.decodeTokens > 0 ? jsxs("span", {
								className: `${board.statPill} ${board.statTokens}`,
								children: [
									jsx("span", { className: board.statGlyph, children: "✦" }),
									teamBoardFormatTokens(stats.decodeTokens),
									" tok"
								]
							}) : null,
							updatedAt !== void 0 ? jsx("span", {
								className: board.statTime,
								children: teamBoardRelative(updatedAt, now, t)
							}) : null
						]
					}),
					/* 任务摘要行：固定一行（标题+截断的描述），不再有悬浮卡。
					 * 悬浮卡的信息与这行重复，而描述全文在展开列表的任务行
					 * 与任务详情页都能看到。 */
					task !== void 0 && jsxs("span", {
						className: board.memberTask,
						children: [
							jsx("span", { className: board.memberTaskTitle, children: task.subject }),
							task.description ? jsx("span", {
								className: board.memberTaskDesc,
								children: task.description
							}) : null
						]
					}),
					/* 展开的任务清单：每行标题+一行信息，点击直达任务详情页。
					 * 停止冒泡——外层卡片的点击是「选中成员」，行内点击是
					 * 「跳任务」，两者不能互相触发。 */
					expanded && taskList.length > 0 ? jsx("span", {
						className: board.memberTaskList,
						onClick: (event) => event.stopPropagation(),
						children: taskList.map((entry) => jsxs("button", {
							type: "button",
							className: board.memberTaskRow,
							style: { ["--mtb-accent"]: teamBoardTaskColor(entry.status) },
							onClick: () => onOpenTask(entry.id),
							title: entry.subject,
							children: [
								jsx("span", { className: board.memberTaskRowTitle, children: entry.subject }),
								jsxs("span", {
									className: board.memberTaskRowMeta,
									children: [
										jsx("span", { className: board.memberTaskRowStatus, children: t(statusKey(entry.status)) }),
										entry.ownerName !== void 0 ? ` · ${entry.ownerName}` : "",
										` · rev ${entry.revision}`
									]
								})
							]
						}, entry.id))
					}) : null
				]
			}),
			hasTasks ? jsx("button", {
				type: "button",
				className: expanded
					? `${board.taskChip} ${board.taskChipOpen}`
					: board.taskChip,
				/* 计数 chip 升级为展开开关：箭头 + 数量。原来它只是个数字，
				 * 看得点不得；现在它是「这个成员有几件事」的入口。 */
				"aria-expanded": expanded,
				"aria-label": t("board.toggleTaskList", { count: taskList.length, name }),
				title: t("board.toggleTaskList", { count: taskList.length, name }),
				onClick: (event) => {
					event.stopPropagation();
					setExpanded(!expanded);
				},
				onKeyDown: (event) => event.stopPropagation(),
				children: [
					jsx("span", {
						className: board.taskChipChevron,
						"aria-hidden": true,
						children: expanded ? "▾" : "▸"
					}),
					taskList.length
				]
			}) : null,
			/* 整卡不再跳转（卡里有任务标题、上下文条，用户常常只想看不
			 * 想走），hover/聚焦时才浮出这个明确的跳转键。 */
			!inert ? jsx("button", {
				type: "button",
				className: board.memberGo,
				title: t("open"),
				"aria-label": t("board.openMember", { name }),
				onClick: () => {
					try {
						openTeammate(sessionId, member.id);
					} catch (reason) {
						onError(String(reason));
					}
				},
				children: "→"
			}) : null
		]
	});
}
function TeamBoardTaskCard({ task, t, onOpen, highlighted, cardRef }) {
	const now = useTeamBoardNow();
	const accent = teamBoardTaskColor(task.status);
	/* 任务完成是这块面板最有价值的一类事件，但 completed 直接掉进灰色组，
	 * 视觉上等同于「没什么可看的」。60 秒内的完成加一层短暂高亮，让刚发生
	 * 的变化能被余光捕捉到。 */
	const justDone = task.status === "completed" && task.updatedAt !== void 0 && now - task.updatedAt < 6e4;
	const taskElapsedMs = teamBoardElapsed(task, now);
	const classes = [board.taskRow];
	if (justDone) classes.push(board.taskRowFresh);
	if (highlighted) classes.push(board.taskRowHighlight);
	return jsxs("button", {
		type: "button",
		ref: cardRef,
		className: classes.join(" "),
		style: { ["--mtb-accent"]: accent },
		title: t("board.detailOpen"),
		onClick: onOpen,
		children: [
			jsxs("div", {
				className: board.taskTitle,
				children: [
					jsx(StateDot, { state: taskDotState(task) }),
					task.subject,
					task.writeScopeWarnings.length > 0 ? jsx("span", {
						className: board.conflictBadge,
						title: task.writeScopeWarnings.join("\n"),
						children: t("board.conflict")
					}) : null
				]
			}),
			jsxs("div", {
				className: board.taskMeta,
				children: [
					jsx("span", { className: board.taskStatus, children: t(statusKey(task.status)) }),
					task.priority !== void 0 ? jsxs("span", { className: board.priorityChip, children: [" · ", t("board.priority", { name: task.priority })] }) : "",
					task.ownerName ? jsxs(Fragment, { children: [" · ", jsx("span", { className: board.taskOwner, children: task.ownerName })] }) : "",
					/* 创建时间用绝对格式：相对时间（"3 天前"）回答不了
					 * "这是哪一轮的任务"，翻历史时还得自己换算。 */
					task.createdAt !== void 0 ? jsx("span", {
						className: board.taskCreated,
						title: t("board.detailCreated"),
						children: ` · ${teamBoardAbsolute(task.createdAt, now)}`
					}) : "",
					/* 接手→完成的墙钟耗时。没有 history（legacy 任务）或还没被
					 * 接手时算不出来，整段不渲染，而不是显示「0 秒」——那会
					 * 读成「瞬间做完了」。 */
					taskElapsedMs !== void 0 ? jsx("span", {
						className: board.taskElapsed,
						title: t("board.detailElapsed"),
						children: ` · ${teamBoardDuration(taskElapsedMs, t)}`
					}) : ""
				]
			})
		]
	});
}
/* 任务列表分组渲染，详情子页「任务不存在」时复用。
 *
 * 左侧轨道与对话记录同一套交互：每个任务一个刻度、等分分布、指针靠近
 * 磁吸放大、↑↓/Home/End 键盘移动、点击滚动定位。分组顺序即刻度顺序，
 * 所以刻度位置和卡片顺序始终一致。 */
function TeamBoardTaskList({ tasksByGroup, t, onOpen, selectedName }) {
	const now = useTeamBoardNow();
	const [activeTaskId, setActiveTaskId] = useState(void 0);
	const itemRefs = useRef({});
	const reduceMotion = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
	const itemRef = useCallback((id) => (node) => {
		if (node === null) delete itemRefs.current[id];
		else itemRefs.current[id] = node;
	}, []);
	const scrollTo = (id) => {
		itemRefs.current[id]?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
	};
	const groups = TEAM_BOARD_TASK_GROUPS.filter((group) => tasksByGroup[group]?.length > 0);
	if (groups.length === 0) return null;
	/* 扁平顺序 = 渲染顺序，刻度的第 i 项与第 i 张卡严格对应。 */
	const flat = groups.flatMap((group) => tasksByGroup[group]);
	return jsxs("div", {
		className: board.chatMain,
		children: [
			jsx(TeamBoardRail, {
				items: flat.map((task) => ({
					id: task.id,
					accent: teamBoardTaskColor(task.status),
					/* 任务面板：head 放主题（和任务卡片的标题同一信息层级，
					 * 扫一眼就能对上），text 放状态 / Owner / rev——这几项
					 * 在卡片上也有，但卡片被滚出视口时面板是唯一的线索。 */
					peek: {
						head: teamBoardRailPeek(task.subject, TEAM_BOARD_RAIL_PEEK_CHARS),
						text: [
							t(statusKey(task.status)),
							task.ownerName !== void 0 ? `${t("owner")}: ${task.ownerName}` : void 0,
							`rev ${task.revision}`,
							/* 更新时间放这里而不是卡片上：卡片已有创建时间（绝对），
							 * 两个时间戳并排会挤；而"多新"是悬浮时才关心的问题，
							 * 相对格式（"3 分钟前"）比绝对时间更直接回答它。 */
							task.updatedAt !== void 0 ? `${t("board.updatedAt")} ${teamBoardRelative(task.updatedAt, now, t)}` : void 0
						].filter((part) => part !== void 0).join(" · ")
					}
				})),
				activeId: activeTaskId,
				onActiveChange: setActiveTaskId,
				onPick: (id, options) => {
					if (options.focus === true) itemRefs.current[id]?.focus?.({ preventScroll: true });
					scrollTo(id);
				},
				labelOf: (item) => {
					const task = flat.find((candidate) => candidate.id === item.id);
					return task === void 0 ? item.id : `${task.subject} · ${t(statusKey(task.status))}`;
				},
				t
			}),
			jsx("div", {
				className: board.chatScroll,
				children: jsx("div", {
					className: board.taskScrollInner,
					children: groups.map((group) =>
						jsx(TeamBoardGroup, {
							title: t(`board.taskGroups.${group}`),
							count: tasksByGroup[group].length,
							color: teamBoardTaskColor(group === "in_progress" ? "running" : group === "ready" ? "idle" : group === "blocked" ? "failed" : "released"),
							children: jsx("div", {
								className: board.tasks,
								children: tasksByGroup[group].map((task) =>
									jsx(TeamBoardTaskCard, {
										task,
										t,
										cardRef: itemRef(task.id),
										onOpen: () => onOpen(task.id),
										highlighted: selectedName !== void 0 && task.ownerName === selectedName
									}, task.id))
							})
						}, group))
				})
			})
		]
	});
}
/* MarkdownText 是宿主 primitives 的净化渲染器（丢弃原始 HTML、只放行
 * http(s) 链接），但它的 labels 是必填 seat——包内无语言兜底。
 * 形状是嵌套的：MarkdownText 只读 labels.code / labels.footnotes 两个键，
 * 其中 labels.code 再原样转发给 CodeBlock 与 CodeToolbar
 * （copyLabel/copiedLabel 直达 CodeBlock，toolbarLabels 直达 CodeToolbar）。 */
/* 对话成员面板宽度：可拖拽调整并持久化到 localStorage。
 *
 * 用 localStorage 而不是把宽度挂在组件 state 上——宽度是「这个人怎么用
 * 这个面板」的偏好，重启后应该还在；挂在组件上每次切 tab 都会弹回默认值。
 * 读盘失败（隐私模式/被禁用）静默回落到默认宽度，不影响面板可用。 */
const TEAM_BOARD_PANEL_MIN = 72;
const TEAM_BOARD_PANEL_MAX = 280;
const TEAM_BOARD_PANEL_DEFAULT = 104;
const TEAM_BOARD_PANEL_KEY = "multeam.panelWidth";
function teamBoardPanelWidth() {
	try {
		const raw = window.localStorage?.getItem(TEAM_BOARD_PANEL_KEY);
		const parsed = raw === null || raw === void 0 ? NaN : Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed)) return TEAM_BOARD_PANEL_DEFAULT;
		return Math.max(TEAM_BOARD_PANEL_MIN, Math.min(TEAM_BOARD_PANEL_MAX, parsed));
	} catch {
		return TEAM_BOARD_PANEL_DEFAULT;
	}
}
function teamBoardSavePanelWidth(value) {
	try {
		window.localStorage?.setItem(TEAM_BOARD_PANEL_KEY, String(value));
	} catch {
		/* 存不下就算了：宽度只影响观感。 */
	}
}
/* 拖拽调宽：按下后接管 pointermove，并用 pointer capture 保证指针移出
 * 元素（甚至移出窗口）时仍收得到事件，松手才结束。面板在右侧，向左拖
 * 是变宽，所以取负 delta。 */
function useTeamBoardPanelWidth() {
	const [width, setWidth] = useState(teamBoardPanelWidth);
	const dragRef = useRef(void 0);
	const onPointerDown = (event) => {
		event.preventDefault();
		dragRef.current = { x: event.clientX, width };
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event) => {
		const drag = dragRef.current;
		if (drag === void 0) return;
		setWidth(Math.max(TEAM_BOARD_PANEL_MIN, Math.min(TEAM_BOARD_PANEL_MAX, drag.width - (event.clientX - drag.x))));
	};
	const endDrag = (event) => {
		if (dragRef.current === void 0) return;
		dragRef.current = void 0;
		event?.currentTarget?.releasePointerCapture?.(event.pointerId);
		setWidth((current) => {
			teamBoardSavePanelWidth(current);
			return current;
		});
	};
	return { width, setWidth, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag };
}
function teamBoardMarkdownLabels(t) {
	return {
		code: {
			copyLabel: t("board.mdCopy"),
			copiedLabel: t("board.mdCopied"),
			toolbarLabels: {
				codeLabel: t("board.mdCodeLabel"),
				wrapLabel: t("board.mdWrap"),
				unwrapLabel: t("board.mdUnwrap")
			}
		},
		footnotes: t("board.mdFootnotes")
	};
}
/* 纯文本视图：优先用宿主自己的 markdown 剥离器（与渲染器同一解析器，
 * 口径一致）；宿主未导出时回落到正则粗剥，至少不显示语法标记。 */
function teamBoardPlainText(text) {
	const extract = extractMarkdownPlainText;
	if (typeof extract === "function") return extract(text, { mode: "all" });
	return text
		.replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, ""))
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/(^|\W)[*_]([^*_]+)[*_]/g, "$1$2");
}
/* 任务详情子页：writeScopes、验收标准、完整描述、逐修订时间线、
 * owner 当前上下文占用（口径：owner 投影的 contextPressure，即
 * 「该 owner 现在的上下文」，非历史逐步快照——引擎未记录后者）。 */
function TeamBoardTaskDetail({ task, leadId, list, onBack, backLabel, onUp, onOpen, openTeammate, onError, t }) {
	const now = useTeamBoardNow();
	const members = list.projectionsBySession[leadId]?.values.agentTeam?.members ?? [];
	const owner = members.find((member) => member.name === task.ownerName);
	const pressure = owner !== void 0 ? list.projectionsBySession[owner.id]?.values.contextPressure : void 0;
	const contextPercent = teamBoardContextPercent(pressure);
	const accent = teamBoardTaskColor(task.status);
	const elapsedMs = teamBoardElapsed(task, now);
	/* 渲染模式偏好：默认 markdown（任务描述实测普遍带编号列表/行内码/
	 * 反引号路径，纯文本会把它们糊成一段）。切换状态挂在详情子页上，
	 * 离开再进来回到默认——不做持久化，避免污染宿主 storage。 */
	const [plain, setPlain] = useState(false);
	const markdownLabels = useMemo(() => teamBoardMarkdownLabels(t), [t]);
	const description = task.description ?? "";
	const hasDescription = description !== "";
	/* 依赖链：blockedBy 要解析成真实任务（拿到 subject/status），
	 * 反向再扫一遍得到「本任务阻塞了谁」。同队任务量级是个位数，
	 * 两趟线性扫描比建索引更直白。 */
	const allTasks = list.projectionsBySession[leadId]?.values.agentTeam?.tasks ?? [];
	const dependencies = useMemo(() => (task.blockedBy ?? []).map((id) => ({
		id,
		task: allTasks.find((candidate) => candidate.id === id)
	})), [task.blockedBy, allTasks]);
	const blocks = useMemo(() => allTasks.filter((candidate) => candidate.id !== task.id && (candidate.blockedBy ?? []).includes(task.id)), [allTasks, task.id]);
	return jsxs("div", {
		className: board.detail,
		style: { ["--mtb-accent"]: accent },
		children: [
			jsxs("div", { className: board.detailBar, children: [
				jsx("button", {
					type: "button",
					className: board.back,
					onClick: onBack,
					children: `← ${backLabel ?? t("board.detailBack")}`
				}),
				/* 「返回上个任务」只在真的跳转过（栈深 >1）时才出现。
				 * 直接从列表进来的第一个任务没有「上个任务」，给一个点了
				 * 等效于左侧返回的按钮只会让人怀疑两者有什么区别。 */
				onUp !== void 0 ? jsx("button", {
					type: "button",
					className: board.detailBackPrev,
					onClick: onUp,
					children: `${t("board.detailBackPrev")} →`
				}) : null
			] }),
			jsxs("div", { className: `${board.detailSection} ${board.detailHead}`, children: [
				jsxs("span", { className: board.detailSubjectRow, children: [
					jsx("span", { className: board.detailSubject, children: task.subject }),
					/* 跳转到 owner 会话：原来在顶部栏占一个整宽按钮，与「返回」
					 * 平级，视觉上像第二个导航动作；实际上它是对「这个任务」的
					 * 追问，属于标题的附属动作，收到标题右侧当图标。
					 * 只对非 lead 的 owner 显示（lead 就是当前视角本身）。 */
					owner !== void 0 && owner.id !== leadId ? jsx("button", {
						type: "button",
						className: board.detailOpen,
						title: t("board.detailOpenOwner", { name: task.ownerName ?? owner.name }),
						"aria-label": t("board.detailOpenOwner", { name: task.ownerName ?? owner.name }),
						onClick: () => {
							try {
								openTeammate(leadId, owner.id);
							} catch (reason) {
								onError(String(reason));
							}
						},
						children: "↗"
					}) : null
				] }),
				jsxs("span", { className: board.detailText, children: [
					jsx("span", { className: board.taskStatus, children: t(statusKey(task.status)) }),
					task.ownerName ? jsxs(Fragment, { children: [" · ", t("owner"), ": ", jsx("span", { className: board.taskOwner, children: task.ownerName })] }) : "",
					jsx("span", { className: board.timelineRev, children: ` · rev ${task.revision}` }),
					task.createdAt !== void 0 ? ` · ${t("board.detailCreated")} ${teamBoardRelative(task.createdAt, now, t)}` : "",
					elapsedMs !== void 0 ? ` · ${t("board.detailElapsed")} ${teamBoardDuration(elapsedMs, t)}` : ""
				] })
			] }),
			jsxs("div", { className: board.detailSection, children: [
				jsxs("span", { className: board.detailSectionHead, children: [
					jsx("span", { className: board.detailLabel, children: t("board.detailDesc") }),
					hasDescription && jsxs("span", {
						className: board.modeSwitch,
						role: "group",
						"aria-label": t("board.viewMode"),
						children: [
							jsx("button", {
								type: "button",
								className: plain ? board.modeBtn : `${board.modeBtn} ${board.modeBtnActive}`,
								"aria-pressed": !plain,
								onClick: () => setPlain(false),
								children: t("board.viewMarkdown")
							}),
							jsx("button", {
								type: "button",
								className: !plain ? board.modeBtn : `${board.modeBtn} ${board.modeBtnActive}`,
								"aria-pressed": plain,
								onClick: () => setPlain(true),
								children: t("board.viewPlain")
							})
						]
					})
				] }),
				hasDescription
					? plain
						? jsx("div", { className: `${board.detailText} ${board.detailPre}`, children: teamBoardPlainText(description) })
						: jsx("div", {
							className: board.detailMarkdown,
							children: jsx(MarkdownText, {
								text: description,
								variant: "compact",
								labels: markdownLabels
							})
						})
					: jsx("div", { className: board.detailText, children: "—" })
			] }),
			task.writeScopes.length > 0 && jsxs("div", { className: board.detailSection, children: [
				jsx("span", { className: board.detailLabel, children: t("writeScopes") }),
				jsx("div", { children: task.writeScopes.map((scope) => jsx("span", { className: board.scopeChip, children: scope }, scope)) }),
				task.writeScopeWarnings.map((warning) => jsxs("div", {
					className: board.conflictNote,
					children: [jsx(StateDot, { state: "warning" }), warning]
				}, warning))
			] }),
			task.acceptance !== void 0 && task.acceptance.length > 0 && jsxs("div", { className: board.detailSection, children: [
				jsx("span", { className: board.detailLabel, children: t("board.detailAcceptance") }),
				jsx("div", { className: board.detailText, children: task.acceptance.map((item, index) => jsxs("div", { children: [`${index + 1}. `, item] }, index)) })
			] }),
			(dependencies.length > 0 || blocks.length > 0) && jsxs("div", { className: board.detailSection, children: [
				dependencies.length > 0 && jsxs(Fragment, { children: [
					jsx("span", { className: board.detailLabel, children: t("board.detailDeps") }),
					jsx("div", { className: board.depList, children: dependencies.map((entry) => jsxs(entry.task !== void 0 ? "button" : "div", {
						/* 有真实任务时整行可点，跳转到该任务的详情页；任务缺失
						 * （被引用但不在板上）时退化成静态行，不假装可点。 */
						...(entry.task !== void 0 ? { type: "button", onClick: () => onOpen(entry.id) } : {}),
						className: entry.task !== void 0
							? `${board.depRow} ${board.depRowLink}`
							: board.depRow,
						style: { ["--mtb-accent"]: teamBoardTaskColor(entry.task?.status ?? "pending") },
						children: [
							jsx("span", { className: board.depGlyph, children: "└" }),
							jsx("span", { className: board.depId, children: entry.id }),
							jsx("span", { className: board.depSubject, children: entry.task?.subject ?? t("board.depMissing") }),
							entry.task !== void 0 ? jsx("span", { className: board.depStatus, children: t(statusKey(entry.task.status)) }) : null
						]
					}, entry.id)) })
				] }),
				blocks.length > 0 && jsxs(Fragment, { children: [
					jsx("span", { className: board.detailLabel, children: t("board.detailBlocks") }),
					jsx("div", { className: board.depList, children: blocks.map((entry) => jsxs("button", {
						type: "button",
						onClick: () => onOpen(entry.id),
						className: `${board.depRow} ${board.depRowLink}`,
						style: { ["--mtb-accent"]: teamBoardTaskColor(entry.status) },
						children: [
							jsx("span", { className: board.depGlyph, children: "└" }),
							jsx("span", { className: board.depId, children: entry.id }),
							jsx("span", { className: board.depSubject, children: entry.subject }),
							jsx("span", { className: board.depStatus, children: t(statusKey(entry.status)) })
						]
					}, entry.id)) })
				] })
			] }),
			task.lesson !== void 0 && jsxs("div", { className: board.detailSection, children: [
				jsx("span", { className: board.detailLabel, children: t("board.detailLesson") }),
				jsx("div", { className: board.detailText, children: task.lesson })
			] }),
			contextPercent !== void 0 && jsxs("div", { className: board.detailSection, children: [
				jsx("span", { className: board.detailLabel, children: t("board.detailContext", { name: task.ownerName ?? "lead" }) }),
				/* 与成员卡片同一套上下文条（色阶 + 进度条 + 数字），
				 * 不再用 `◧ 23% · 57.8k tok` 这种纯文本——两处口径不同
				 * 会让人以为读的是两个指标。 */
				jsxs("span", {
					className: board.ctxPill,
					style: {
						["--mtb-ctx"]: String(contextPercent),
						["--mtb-ctx-color"]: teamBoardContextColor(contextPercent)
					},
					title: t("board.contextUsage", { percent: contextPercent }),
					children: [
						jsx("span", { className: board.ctxBar, children: jsx("span", { className: board.ctxFill }) }),
						jsxs("span", { className: board.ctxNum, children: [contextPercent, "%"] }),
						pressure?.projectedTokens !== void 0 ? jsxs("span", {
							className: board.ctxTokens,
							children: [`· ${teamBoardFormatTokens(pressure.projectedTokens)} tok`]
						}) : null
					]
				})
			] }),
			task.history !== void 0 && task.history.length > 0 && jsxs("div", { className: board.detailSection, children: [
				jsx("span", { className: board.detailLabel, children: t("board.detailTimeline") }),
				jsx("div", { className: board.timeline, children: task.history.map((entry) => jsxs("div", { className: board.timelineItem, style: { ["--mtb-accent"]: teamBoardTaskColor(entry.status) }, children: [
					jsx("span", { className: board.timelineRev, children: `rev ${entry.revision}` }),
					jsx("span", { className: board.timelineAct, children: ` · ${entry.action} → ` }),
					jsx("span", { className: board.timelineStatus, children: t(statusKey(entry.status)) }),
					entry.ownerName !== void 0 ? ` · ${entry.ownerName}` : "",
					jsx("span", { className: board.timelineWhen, children: teamBoardRelative(entry.at, now, t) })
				] }, entry.revision)) })
			] })
		]
	});
}
/* 把正文按 query 切成命中/非命中片段。needle 已小写；用切片而不是
 * 正则，避免用户输入里的正则元字符（如 `(` ）把匹配炸掉。 */
/* 从正文里裁出命中处的一小段，用于搜索结果里的「命中摘要」。
 * 命中词可能出现在 markdown 语法记号里（如链接目标），但这里只做
 * 纯文本裁切——摘要的目的是定位，不需要保留格式，且 MarkdownText
 * 不暴露「第几个纯文本字符」的映射，无法在渲染后的 DOM 上高亮。
 * 命中词为空或找不到时返回原文（调用方只在命中时才渲染）。 */
/* 时间线悬浮面板的摘要行：把 markdown 正文压成一行纯文本，超长才截断。
 *
 * 三步都必要：
 * - `teamBoardPlainText` 剥离语法记号（否则 `# `/`**`/围栏会读成乱码）；
 * - `\s+` → 空格：换行在单行面板里会变成一个突兀的空洞，且让「截多少
 *   字」失去意义（前 42 个字符可能全被空行占掉）；
 * - 只有真的截断才补 `…`，否则短消息也挂省略号像没说完。
 */
function teamBoardRailPeek(text, max) {
	const flat = teamBoardPlainText(text).replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
function teamBoardSnippet(text, needle) {
	const source = text ?? "";
	if (needle === "") return source;
	const index = source.toLowerCase().indexOf(needle);
	if (index === -1) return source;
	const PAD = 24;
	const from = Math.max(0, index - PAD);
	const to = Math.min(source.length, index + needle.length + PAD);
	/* 省略号只在真的截断时加，避免短消息也挂上「…」显得没裁过。 */
	return `${from > 0 ? "…" : ""}${source.slice(from, to).trim()}${to < source.length ? "…" : ""}`;
}
function highlightText(text, needle) {
	const source = text ?? "";
	const lower = source.toLowerCase();
	if (needle === "" || !lower.includes(needle)) return source;
	const parts = [];
	let cursor = 0;
	let index = lower.indexOf(needle, cursor);
	let key = 0;
	while (index !== -1) {
		if (index > cursor) parts.push(source.slice(cursor, index));
		parts.push(jsx("mark", { className: board.hitMark, children: source.slice(index, index + needle.length) }, `hit-${key++}`));
		cursor = index + needle.length;
		index = lower.indexOf(needle, cursor);
	}
	if (cursor < source.length) parts.push(source.slice(cursor));
	return parts;
}
/* 轨道刻度的位置重映射。
 *
 * 目标：静止时「中间密、两头疏」，鼠标所在处刻度被推开变疏。
 *
 * 做法不是「给刻度加位移」——那样指针两侧的 sign 翻转会造成不连续，
 * 把前后刻度推成逆序（我实测过：amp ≥0.12 就开始非单调，点击定位会
 * 落到错误的条目上）。改成对 rank 做**单调重映射**：
 *
 *   p(r) = ∫₀ʳ D(u)du / ∫₀¹ D(u)du ,  D(u) = 静态导数(u) · 局部放大(u)
 *
 * 只要 D > 0 处处成立，p 必然严格单调；两端归一化后 p(0)=0、p(1)=1，
 * 轨道两端不会空出。局部放大在指针附近把导数放大，于是那里的刻度被
 * 拉开，而远处不受影响。
 *
 * 实现上用查表：每次指针移动重算一次积分（LUT 步数固定，成本恒定），
 * 不依赖轨道像素尺寸，所以窗口缩放时不需要重新计算。
 */
const RAIL_LUT_STEPS = 96;      /* 位置查表精度 */
const RAIL_PUSH_BOOST = 0.8;    /* 指针处导数放大倍数（0 = 完全等距） */
const RAIL_PUSH_RADIUS = 0.06;  /* 影响半径；越小越「只动附近几条」 */

/* 生成 rank → 位置 的查表函数；pointer 为 undefined 时只有静态压缩。 */
/* 生成 rank → 位置 的查表函数。
 *
 * 基础权重恒为 1 → 静止时是**严格等距**（p(r) = r）。
 * 指针附近把导数放大，于是那里刻度被拉开，远处不受影响。
 *
 * 用积分归一化：p(r) = ∫₀ʳ D(u)du / ∫₀¹ D(u)du。
 * D ≥ 1 > 0 处处成立 → p 严格单调（刻度永不换序，点击定位不会错），
 * 且归一化天然保证 p(0)=0、p(1)=1（轨道两端不空）。 */
function teamBoardRailMap(pointer) {
	const weight = new Array(RAIL_LUT_STEPS + 1);
	for (let i = 0; i <= RAIL_LUT_STEPS; i++) {
		const r = i / RAIL_LUT_STEPS;
		let d = 1;
		if (pointer !== void 0) {
			/* 距离在等距空间里量（基础就是 r 本身），所以「近」= 刻度序号近。 */
			const dist = Math.abs(r - pointer);
			if (dist < RAIL_PUSH_RADIUS) {
				const w = 1 - dist / RAIL_PUSH_RADIUS;
				d += RAIL_PUSH_BOOST * w * w;
			}
		}
		weight[i] = d;
	}
	const cum = new Array(RAIL_LUT_STEPS + 1);
	cum[0] = 0;
	for (let i = 1; i <= RAIL_LUT_STEPS; i++) cum[i] = cum[i - 1] + (weight[i] + weight[i - 1]) / 2;
	const total = cum[RAIL_LUT_STEPS];
	if (total <= 0) return (r) => r;
	for (let i = 0; i <= RAIL_LUT_STEPS; i++) cum[i] /= total;
	return (r) => {
		const x = Math.max(0, Math.min(1, r)) * RAIL_LUT_STEPS;
		const i = Math.floor(x);
		if (i >= RAIL_LUT_STEPS) return 1;
		const f = x - i;
		return cum[i] * (1 - f) + cum[i + 1] * f;
	};
}
/* 通用左侧时间线轨道：对话记录与任务列表共用。
 *
 * 刻度等距排布（第 i 条落在 i/(n-1)），不按真实 offsetTop 定位：rail 固定在
 * 视口里、内容在滚动流里，是两套坐标系，一旦滚动就错位。等距后它是一条纯粹
 * 的「第几条」标尺，点第 3 个刻度必然跳到第 3 条。
 *
 * 刻度是压在竖轨上的水平短横条，几何中心对准竖轨。
 * 鼠标所在处刻度被局部推开（只动附近几条），方便点准；离开后回到等距。
 *
 * items: [{ id, accent }]；onPick(id) 为点击行为。
 */
/* 时间线悬浮面板：显示「标题行 + 摘要行」。
 *
 * 面板只认 `{ top, head, text }`——head/text 的具体内容属于调用方的
 * 领域知识（对话是「谁发给谁 + 正文开头」，任务是「主题 + 状态·Owner」），
 * rail 不该知道消息和任务的区别，否则每加一种时间线就要改这里。
 *
 * 定位用 fixed + 测量夹取，理由同成员卡悬浮卡：面板挂在 rail 上，
 * 而 rail 的祖先链里有 overflow:hidden（对话 tab 的 body），
 * 用绝对定位贴轨道两端时会被裁掉半截。fixed 跳出裁剪，再按视口
 * 夹取纵坐标，任何滚动位置都不会飞出去。
 *
 * 横向固定在轨道的右侧（`railBox.right + 6`），因为面板是向右展开
 * 盖在列表上的，这是它作为「识读辅助」的预期位置。 */
function TeamBoardRailPeek({ peek, bandRef }) {
	const boxRef = useRef(null);
	const [pos, setPos] = useState(void 0);
	useLayoutEffect(() => {
		const node = boxRef.current;
		const band = bandRef.current;
		if (node === null || band === null) return;
		const size = node.getBoundingClientRect();
		const bandBox = band.getBoundingClientRect();
		const railBox = band.parentElement.getBoundingClientRect();
		const viewportH = window.innerHeight;
		/* 刻度在 band 内的比例 → 屏幕纵坐标。 */
		const centerY = bandBox.top + peek.top * bandBox.height;
		const top = Math.max(
			TEAM_BOARD_POPOVER_MARGIN,
			Math.min(centerY - size.height / 2, viewportH - size.height - TEAM_BOARD_POPOVER_MARGIN)
		);
		setPos({ top, left: railBox.right + 6 });
	}, [peek, bandRef]);
	return jsxs("span", {
		ref: boxRef,
		className: board.railPeek,
		role: "tooltip",
		style: pos === void 0
			? { top: 0, left: 0, visibility: "hidden" }
			: { top: pos.top, left: pos.left },
		children: [
			peek.head !== void 0 ? jsx("span", { className: board.railPeekWho, children: peek.head }) : null,
			/* 省略号由调用方决定（`text` 已自带 `…`），不在这里无脑追加：
			 * 任务的 text 是完整信息（「进行中 · Owner: worker-a · rev 4」），
			 * 后缀一个省略号会读成「还没写完」。 */
			peek.text !== void 0 && peek.text !== "" ? jsx("span", {
				className: board.railPeekText,
				children: peek.text
			}) : null
		]
	});
}
function TeamBoardRail({ items, activeId, onActiveChange, onPick, dimmed, hitIds, labelOf, t }) {
	/* 指针在轨道上的相对位置（0~1）。undefined = 指针不在轨道上，
	 * 所有刻度回到基础尺寸。 */
	const [pointer, setPointer] = useState(void 0);
	/* 位置查表：指针变化时重建（LUT 步数固定，成本恒定）。
	 * 静止时 pointer 为 undefined，只做静态中心压缩。 */
	const place = useMemo(() => teamBoardRailMap(pointer), [pointer]);
	const lastIndex = Math.max(1, items.length - 1);
	/* rank → 实际位置。rank 是「第几条」的均匀参数，place 把它变成
	 * 「中间密两头疏 + 指针处推开」的位置。 */
	const ratioOf = (index) => place(index / lastIndex);
	/* 强调强度 0~1：0 = 普通，1 = 指针正落在该刻度上。
	 *
	 * 只驱动**加宽**（刻痕变粗），不再负责「推开」——推开由 place()
	 * 的位置重映射完成。两者分工：位置管间隔，宽度管强调，避免同一处
	 * 双重动效显得吵。 */
	const emphasisOf = (index) => {
		if (pointer === void 0) return 0;
		const distance = Math.abs(ratioOf(index) - pointer);
		if (distance >= 0.12) return 0;
		return 1 - distance / 0.12;
	};
	/* 指针比例必须相对 **band** 量（刻度都在 band 里）。
	 * 相对 rail 量的话会差出上下各 14px 的留白，指针明明在刻度上，
	 * 算出来的比例却是偏移的，推开位置对不上。 */
	const pointerRatioOf = (event) => {
		const band = event.currentTarget.querySelector(`.${board.chatRailBand}`);
		const box = band?.getBoundingClientRect();
		if (box === undefined || box.height <= 0) return void 0;
		return (event.clientY - box.top) / box.height;
	};
	/* 距某比例最近的那条刻度。
	 *
	 * 刻度只有 3px 高，把它当成点击热区的话，差 2px 就点空——用户
	 * 明明看着「最近的那条」已经亮起，按下却没反应。所以热区是整条
	 * 轨道，落点按「谁离得最近」解析成目标，与视觉上的亮起完全同源
	 * （都用 ratioOf 比较），不会出现「亮的和跳的不是同一条」。 */
	const nearestIndexOf = (ratio) => {
		if (items.length === 0) return -1;
		if (ratio === void 0) return items.length - 1;
		let best = 0;
		let bestDistance = Infinity;
		for (let index = 0; index < items.length; index++) {
			const distance = Math.abs(ratioOf(index) - ratio);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		}
		return best;
	};
	/* 悬浮面板：显示「谁发给谁 + 正文开头」。挂在 band 上，位置跟随
	 * 最近刻度的纵坐标（而不是指针），这样面板与高亮的那条对齐。 */
	const [peek, setPeek] = useState(void 0);
	/* band 的 DOM 引用：面板要按 band 的真实矩形换算出刻度的屏幕纵坐标
	 * （比例 → 像素），所以定位不能只靠百分比。 */
	const bandRef = useRef(null);
	const move = (index, delta) => {
		const next = items[index + delta];
		if (next === void 0) return;
		onPick(next.id, { focus: true });
	};
	const track = (event) => {
		const ratio = pointerRatioOf(event);
		setPointer(ratio);
		const index = nearestIndexOf(ratio);
		if (index < 0) return;
		const item = items[index];
		onActiveChange(item.id);
		/* 面板内容由 item 自带（调用方的领域知识）：对话给「谁发给谁 +
		 * 正文开头」，任务给「主题 + 状态·Owner」。item.peek 缺省时不
		 * 弹面板，而不是弹一个空壳。 */
		setPeek(item.peek !== void 0
			? { top: ratioOf(index), head: item.peek.head, text: item.peek.text ?? "" }
			: void 0);
	};
	return jsxs("div", {
		className: board.chatRail,
		onMouseMove: track,
		onMouseLeave: () => {
			setPointer(void 0);
			setPeek(void 0);
			onActiveChange(void 0);
		},
		/* 整条轨道都是点击热区：按落点找最近刻度，而不是要求精确命中
		 * 3px 高的刻痕。 */
		onClick: (event) => {
			const index = nearestIndexOf(pointerRatioOf(event));
			const item = items[index];
			if (item !== void 0) onPick(item.id, {});
		},
		children: [
			jsxs("div", {
				/* band 承担上下留白：刻度都在它内部，top:% 相对它解析，
				 * 于是整条刻度带在轨道里垂直居中（两端留白相等），
				 * 而刻度之间保持等距。 */
				className: board.chatRailBand,
				ref: bandRef,
				children: [
				jsx("div", { className: board.chatRailTrack }),
				items.map((item, index) => jsx("button", {
					type: "button",
					/* tick 只做视觉，不接收指针事件：热区统一由外层容器
					 * 承担，否则「悬停在刻痕上」与「悬停在刻痕之间」会走
					 * 两条路径，高亮与点击可能落到不同条目。 */
					className: [
						board.chatTick,
						activeId === item.id ? board.chatTickActive : "",
						dimmed && !dimmed.has(item.id) && activeId !== item.id ? board.chatTickDim : "",
						hitIds !== void 0 && hitIds.has(item.id) ? board.chatTickHit : ""
					].filter(Boolean).join(" "),
					style: {
						top: `${ratioOf(index) * 100}%`,
						["--mtb-tick-grow"]: String(emphasisOf(index)),
						["--mtb-accent"]: item.accent
					},
					"aria-label": labelOf(item),
					/* 键盘仍逐个可达：Tab 进刻痕、方向键上下移动。
					 * 指针交互走容器，键盘交互走刻痕，互不干扰。 */
					onFocus: () => onActiveChange(item.id),
					onKeyDown: (event) => {
						if (event.key === "ArrowDown") { event.preventDefault(); move(index, 1); }
						else if (event.key === "ArrowUp") { event.preventDefault(); move(index, -1); }
						else if (event.key === "Home") { event.preventDefault(); move(index, -index); }
						else if (event.key === "End") { event.preventDefault(); move(index, items.length - 1 - index); }
					}
				}, item.id)),
				/* 面板用 fixed 定位 + 测量后夹取，和成员卡悬浮卡同一套
				 * 思路：band 的 top% 会让面板在轨道两端被祖先的
				 * overflow:hidden 裁掉（translateY(-50%) 还会再溢出
				 * 半个面板高），而 CSS 里夹取需要同时知道百分比和像素
				 * 偏移——那是 `calc(number * (percentage - length))`
				 * 这类会被部分浏览器整条丢弃的写法。 */
				peek !== void 0 ? jsx(TeamBoardRailPeek, {
					peek,
					bandRef
				}) : null
				]
			})
		]
	});
}
/* 对话搜索栏：只放搜索。成员切换移到右侧独立面板——成员一多，顶栏 chips
 * 会换行并挤掉搜索框，两者抢同一行的空间。 */
function ChatSearchBar({ query, setQuery, hitCount, onStepHit, t }) {
	return jsxs("div", {
		className: board.chatSearch,
		children: [
			jsx("input", {
				type: "search",
				className: board.searchInput,
				value: query,
				placeholder: t("board.chatSearch"),
				"aria-label": t("board.chatSearch"),
				onChange: (event) => setQuery(event.target.value)
			}),
			query !== "" ? jsxs(Fragment, { children: [
				jsx("span", { className: board.searchCount, children: t("board.chatHits", { count: hitCount }) }),
				jsx("button", {
					type: "button",
					className: board.searchNav,
					"aria-label": t("board.chatPrev"),
					onClick: () => onStepHit(-1),
					children: "↑"
				}),
				jsx("button", {
					type: "button",
					className: board.searchNav,
					"aria-label": t("board.chatNext"),
					onClick: () => onStepHit(1),
					children: "↓"
				})
			] }) : null
		]
	});
}
/* 对话成员面板：独立右栏、独立滚动。成员多时不必与消息抢纵向空间，
 * 也不会把搜索框挤走。只列真正在对话中出现过的参与者（from/to）——
 * 名单里从没发过消息的人放进来只会稀释信号。
 *
 * 分组按成员状态（与成员 tab 同一套状态推导），组内按消息条数降序：
 * 一眼看出「谁在参与」而不是只看到一长串名字。每组可独立折叠。 */
function ChatMemberPanel({ members, messages, selectedName, onSelectMember, sessions, t }) {
	const list = useTeamBoardSessions(sessions);
	const panel = useTeamBoardPanelWidth();
	/* 组开合状态：默认全展开，点组头切换。用对象而不是 Set，便于直接拷进新对象触发重渲。 */
	const [collapsed, setCollapsed] = useState({});
	const counts = useMemo(() => {
		const tally = {};
		messages.forEach((message) => {
			if (message.from !== void 0) tally[message.from] = (tally[message.from] ?? 0) + 1;
			if (message.to !== void 0) tally[message.to] = (tally[message.to] ?? 0) + 1;
		});
		return tally;
	}, [messages]);
	/* 名字 → 成员：拿运行态与头像色。只出现在消息里、已不在名单上的人
	 * （已释放的队友）仍要能筛，归到 released 组。 */
	const byName = useMemo(() => {
		const map = new Map();
		members.forEach((member) => map.set(member.name ?? member.id, member));
		return map;
	}, [members]);
	/* lead 单独成组：它不是「队员状态」，而是视角本身，混进 running 组会误导。 */
	const groups = useMemo(() => {
		const buckets = {};
		Object.keys(counts).forEach((name) => {
			const member = byName.get(name);
			const status = name === "lead" ? "lead" : member === void 0 ? "released" : teamBoardMemberStatus(member, list.byId[member.id]?.running);
			const bucket = buckets[status] ??= { status, people: [] };
			bucket.people.push({ name, count: counts[name], member });
		});
		const order = ["lead", ...TEAM_BOARD_MEMBER_GROUPS];
		return order.filter((status) => buckets[status] !== void 0).map((status) => {
			buckets[status].people.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
			return buckets[status];
		});
	}, [counts, byName, list]);
	const total = useMemo(() => Object.values(counts).reduce((sum, n) => sum + n, 0), [counts]);
	if (groups.length === 0) return null;
	const row = (label, count, key, member) => {
		const on = selectedName === key;
		const classes = [board.chatMember];
		if (on) classes.push(board.chatMemberOn);
		const status = key === void 0 ? void 0 : member === void 0 ? "released" : teamBoardMemberStatus(member, list.byId[member.id]?.running);
		return jsxs("button", {
			type: "button",
			className: classes.join(" "),
			"aria-pressed": on,
			style: { ["--mtb-accent"]: `oklch(65% 0.07 ${teamBoardAvatarHue(key ?? "")})` },
			onClick: () => onSelectMember(key),
			title: label,
			children: [
				jsx("span", { className: board.chatMemberDot, children: teamBoardAvatarText(label) }),
				jsx("span", { className: board.chatMemberName, children: label }),
				status !== void 0 ? jsx("span", { className: board.chatMemberStatus, style: { background: teamBoardStatusColor(status) } }) : null,
				jsx("span", { className: board.chatMemberCount, children: count })
			]
		}, key ?? "__all__");
	};
	return jsxs("div", {
		className: board.chatMembers,
		style: { width: panel.width },
		role: "group",
		"aria-label": t("board.chatMembers"),
		children: [
			jsx("div", {
				className: board.chatMembersResize,
				role: "separator",
				"aria-orientation": "vertical",
				"aria-label": t("board.resizePanel"),
				tabIndex: 0,
				onPointerDown: panel.onPointerDown,
				onPointerMove: panel.onPointerMove,
				onPointerUp: panel.onPointerUp,
				onPointerCancel: panel.onPointerCancel,
				/* 键盘可达：左右方向键逐档调宽（无拖拽时也能用）。 */
				onKeyDown: (event) => {
					if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
					event.preventDefault();
					const step = event.key === "ArrowLeft" ? 12 : -12;
					panel.setWidth((current) => {
						const next = Math.max(TEAM_BOARD_PANEL_MIN, Math.min(TEAM_BOARD_PANEL_MAX, current + step));
						teamBoardSavePanelWidth(next);
						return next;
					});
				}
			}),
			/* 「全部」不参与分组：它是清除筛选，不是一个成员。固定在顶部不随组滚动。 */
			jsx("div", { className: board.chatMembersFixed, children: row(t("board.chatFilterAll"), total, void 0, void 0) }),
			jsx("div", {
				className: board.chatMembersList,
				children: groups.map((group) => {
					const isOpen = collapsed[group.status] !== true;
					return jsxs("div", {
						className: board.chatGroup,
						children: [
							jsxs("button", {
								type: "button",
								className: board.chatGroupHead,
								"aria-expanded": isOpen,
								onClick: () => setCollapsed((current) => ({ ...current, [group.status]: isOpen })),
								children: [
									jsx("span", { className: board.chatGroupDot, style: { background: group.status === "lead" ? TEAM_BOARD_STATUS_COLORS.idle : teamBoardStatusColor(group.status) } }),
									jsx("span", { className: board.chatGroupTitle, children: group.status === "lead" ? t("board.chatGroupLead") : t(`board.memberGroups.${group.status}`) }),
									jsx("span", { className: board.chatMemberCount, children: group.people.length }),
									jsx("span", { className: board.chatGroupChevron, style: { transform: isOpen ? "none" : "rotate(-90deg)" }, children: "▾" })
								]
							}),
							isOpen ? group.people.map((person) => row(person.name, person.count, person.name, person.member)) : null
						]
					}, group.status);
				})
			})
		]
	});
}
/* 对话记录子页：wire view 的 messages（lead↔队员、队员↔队员的邮箱
 * 历史），按 queuedAt 升序，lead 视角自身消息靠右。
 *
 * 左侧时间线：每条消息一个刻度，纵坐标按 queuedAt 在会话时间跨度内的
 * 比例投影（不是序号均匀分布——均匀分布会谎报时间间隔）。鼠标进入轨道
 * 时跟随指针显示简要浮层，点击刻度滚动到对应消息。 */
function TeamBoardChat({ messages, members, t, selectedName, onSelectMember, sessions }) {
	const now = useTeamBoardNow();
	const [query, setQuery] = useState("");
	/* 只记录「哪条被悬停」，不再记坐标：浮层面板已移除，悬停只驱动
	 * 刻度高亮与卡片放大，两者都只认 id。 */
	const [activeId, setActiveId] = useState(void 0);
	const markdownLabels = useMemo(() => teamBoardMarkdownLabels(t), [t]);
	const itemRefs = useRef({});
	/* 筛选只有「成员面板选中的那个人」这一个来源——顶部 chips 已随成员
	 * 面板的重构一并移除，不存在需要回落的第二来源。 */
	const effectiveFilter = selectedName;
	const ordered = useMemo(() => [...messages]
		.filter((message) => effectiveFilter === void 0 || message.from === effectiveFilter || message.to === effectiveFilter)
		.sort((left, right) => (left.queuedAt ?? 0) - (right.queuedAt ?? 0)), [messages, effectiveFilter]);
	/* 搜索：命中判定不区分大小写；query 同时决定命中摘要和刻度标记。
	 * 命中计数在筛选后的集合上算，与用户看到的列表一致。 */
	const needle = query.trim().toLowerCase();
	const hits = useMemo(() => {
		if (needle === "") return void 0;
		return new Set(ordered.filter((message) => (message.text ?? "").toLowerCase().includes(needle)).map((message) => message.id));
	}, [ordered, needle]);
	const activeHits = useMemo(() => ordered.filter((message) => hits?.has(message.id) === true), [ordered, hits]);
	const stepHit = (delta) => {
		const index = activeHits.findIndex((message) => message.id === activeId);
		const next = activeHits[(index < 0 ? (delta > 0 ? 0 : activeHits.length - 1) : index + delta + activeHits.length) % activeHits.length];
		if (next !== void 0) scrollTo(next.id);
	};
	/* 减少动效偏好下不做平滑滚动——scrollIntoView 的 behavior 不受
	 * CSS 媒体查询约束，必须在这里显式判断。 */
	const reduceMotion = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
	const itemRef = useCallback((id) => (node) => {
		if (node === null) delete itemRefs.current[id];
		else itemRefs.current[id] = node;
	}, []);
	const scrollTo = (id) => {
		itemRefs.current[id]?.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
	};
	if (messages.length === 0) return jsx("div", { className: board.empty, children: t("board.chatEmpty") });
	const accentOf = (message) => message.from === "lead" ? TEAM_BOARD_STATUS_COLORS.idle : `oklch(65% 0.09 ${teamBoardAvatarHue(message.from)})`;
	return jsxs("div", {
		className: board.chatWrap,
		children: [
			jsx(ChatSearchBar, {
				query,
				setQuery,
				hitCount: activeHits.length,
				onStepHit: stepHit,
				t
			}),
			jsxs("div", {
				className: board.chatMain,
				children: [
					jsx(TeamBoardRail, {
						items: ordered.map((message) => ({
							id: message.id,
							accent: message.delivered ? accentOf(message) : TEAM_BOARD_STATUS_COLORS.failed,
							peek: {
								head: `${message.from} → ${message.to}`,
								/* 摘要是**纯文本**：原文是 markdown，直接截断会把
								 * `# `/`**`/围栏记号一起带出来，读起来像乱码。
								 * 剥离后压掉换行、截到固定长度。只有真的截断了
								 * 才补省略号，否则短消息也挂个「…」像没说完。 */
								text: teamBoardRailPeek(message.text ?? "", TEAM_BOARD_RAIL_PEEK_CHARS)
							}
						})),
						activeId,
						onActiveChange: setActiveId,
						onPick: (id, options) => {
							/* 点击滚动定位；键盘移动额外把焦点交给消息卡，
							 * 让 Tab 之后的位置与视觉位置一致。 */
							if (options.focus === true) itemRefs.current[id]?.focus?.({ preventScroll: true });
							scrollTo(id);
						},
						dimmed: hits,
						hitIds: hits,
						labelOf: (item) => {
							const message = ordered.find((candidate) => candidate.id === item.id);
							return message === void 0 ? item.id : t("board.chatJumpTo", { from: message.from, to: message.to });
						},
						t
					}),
					jsx("div", {
						className: board.chatScroll,
						children: jsx("div", {
							className: board.chat,
							children: ordered.map((message) => jsxs("div", {
								ref: itemRef(message.id),
								/* 悬停消息卡：联动的只有刻度高亮 + 卡片自身放大（CSS）。
								 * 不再弹浮层面板——消息卡已经把 from/to/时间/正文都显示了，
								 * 浮层只是把同样的内容再说一遍。 */
								onMouseEnter: () => setActiveId(message.id),
								onMouseLeave: () => setActiveId(void 0),
								className: [
									message.delivered
										? message.from === "lead" ? `${board.chatItem} ${board.chatItemMine}` : board.chatItem
										: `${board.chatItem}${message.from === "lead" ? ` ${board.chatItemMine}` : ""} ${board.chatItemUndelivered}`,
									hits !== void 0 && hits.has(message.id) ? board.chatItemHit : ""
								].filter(Boolean).join(" "),
								style: { ["--mtb-accent"]: message.delivered ? accentOf(message) : TEAM_BOARD_STATUS_COLORS.failed },
								children: [
									jsxs("span", { className: board.chatHead, children: [
										jsx("span", { className: board.chatFrom, children: message.from }),
										jsx("span", { className: board.chatArrow, children: " → " }),
										jsx("span", { className: board.chatTo, children: message.to }),
										!message.delivered ? jsxs("span", { className: board.chatPending, children: [
											jsx(StateDot, { state: "warning" }),
											t("board.chatPending")
										] }) : null,
										message.queuedAt !== void 0 ? jsx("span", { className: board.timelineWhen, children: teamBoardRelative(message.queuedAt, now, t) }) : null
									] }),
									jsx("div", {
										/* 搜索态也走 MarkdownText：命中是「在哪条消息里」，
										 * 由卡片级 chatItemHit 表达，正文保持代码块/列表的
										 * 原有渲染。以前搜索会把正文整个降级成纯文本，
										 * 一搜代码块就塌成一行——搜索结果本来就是要细读的。 */
										className: board.chatMarkdown,
										children: jsx(MarkdownText, {
											text: message.text ?? "",
											variant: "compact",
											labels: markdownLabels
										})
									}),
									/* 命中摘要：正文保留 markdown，但用户仍需要在长文里
									 * 一眼看到命中词落在哪。摘录命中处前后各一小段，
									 * 高亮命中词，与卡片标记互补而不是重复。 */
									hits !== void 0 && hits.has(message.id) ? jsx("div", {
										className: board.chatSnippet,
										children: highlightText(teamBoardSnippet(message.text, needle), needle)
									}) : null
								]
							}, message.id))
						})
					}),
					jsx(ChatMemberPanel, {
						members,
						messages,
						selectedName,
						onSelectMember,
						sessions,
						t
					})
				]
			}),
		]
	});
}
/* ── 依赖图（DAG）布局 ──────────────────────────────────────────────
 *
 * 分层：层号 = 该任务在依赖链上的最长深度。`blockedBy` 里的任务在更靠
 * 左的层（先做），依赖它的在更靠右的层（后做），于是「箭头一律从左指
 * 向右」——这正是用户要的「可以看出谁依赖谁」。用**最长**路径而不是
 * 最短，否则 A 同时依赖 B、C，而 C 又依赖 B 时，A 会和 C 挤在同一层，
 * 跨层的边会糊在一起。
 *
 * 环：core 的 invariant 会拒绝自环和复杂环，但客户端不能假设投影数据
 * 永远合法——历史遗留、事件被裁剪、投影瞬断都可能让图里出现环。这里
 * 用 Kahn 拓扑排序的变体：一轮扫不出可入队的节点（即剩下的全在环里）
 * 就直接把它们按原始顺序追加到下一层，保证**算法一定终止**，且环上的
 * 任务仍然出现在图里（降级为「排不出序」而不是丢失）。
 */
/* lead 根节点的合成 id。用不可能与真实任务 id 冲突的前缀：真实 id 形如
 * `task-N`，且这个 id 会出现在 DOM key 与边端点上，必须唯一。 */
const GRAPH_LEAD_ID = "__lead__";
/* 「没有依赖的任务」的归属边：lead → 任务。
 *
 * 语义：第 0 层的任务不依赖任何前置，它们是 lead 直接派下来的工作（无论
 * 是 lead reassign 指派的还是成员自己 claim 的，来源都是 lead 这一轮
 * 调度）。没有这条边，它们就是一堆飘着的孤立节点，看不出「谁交代的」。
 *
 * 为什么只连第 0 层：有前置的任务由前置驱动（依赖边已经表达了归属），
 * 再连一条 lead→它 的边会让「lead 直接派发」和「等前置完成」两种非常
 * 不同的关系看起来一样，图反而更难读。 */
function teamBoardGraphModel(tasks) {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	/* 只保留两端都存在的依赖边：blockedBy 可能引用被删除的任务，
	 * 那些边画不出来（没有目标节点），强行画会指向虚空。 */
	const edges = [];
	tasks.forEach((task) => {
		(task.blockedBy ?? []).forEach((blockerId) => {
			if (byId.has(blockerId)) edges.push({ from: blockerId, to: task.id });
		});
	});
	const incoming = new Map(tasks.map((task) => [task.id, 0]));
	const outgoing = new Map(tasks.map((task) => [task.id, []]));
	edges.forEach((edge) => {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
		outgoing.get(edge.from).push(edge.to);
	});
	const depth = new Map();
	/* 入度为 0 的是链头（不依赖任何任务），从第 1 层开始——第 0 层留给
	 * 合成的 lead 根节点。整体偏移一位，而不是让 lead 占负层号：
	 * 负层号会让 x 坐标为负，节点跑到画布外。 */
	let frontier = tasks.filter((task) => incoming.get(task.id) === 0).map((task) => task.id);
	frontier.forEach((id) => depth.set(id, 1));
	let guard = 0;
	while (frontier.length > 0 && guard++ <= tasks.length + 1) {
		const next = [];
		frontier.forEach((id) => {
			const base = depth.get(id) ?? 0;
			(outgoing.get(id) ?? []).forEach((childId) => {
				/* 最长路径：只在能推得更远时才更新，否则保持已有深度。 */
				if ((depth.get(childId) ?? 0) < base + 1) depth.set(childId, base + 1);
				incoming.set(childId, incoming.get(childId) - 1);
				if (incoming.get(childId) === 0) next.push(childId);
			});
		});
		frontier = next;
	}
	/* 环兜底：没被拓扑排到的节点（入度永远降不到 0）统一放到最右一层，
	 * 而不是丢掉——即使数据异常，用户仍看得到这些任务，且它们被明确
	 * 隔离开（而不是混进正常层里伪造出一个依赖顺序）。 */
	const maxAcyclic = tasks.reduce((max, task) => depth.has(task.id) ? Math.max(max, depth.get(task.id)) : max, 1);
	const cyclic = tasks.filter((task) => !depth.has(task.id));
	cyclic.forEach((task) => depth.set(task.id, maxAcyclic + 1));
	const maxDepth = cyclic.length > 0 ? maxAcyclic + 1 : maxAcyclic;
	/* lead 根节点：不是真任务，所以只作为一个布局用的伪对象存在，
	 * 不进 byId（否则会被当成可打开的任务）。 */
	const leadNode = { id: GRAPH_LEAD_ID, subject: "", status: "lead", ownerName: void 0, synthetic: true };
	const layers = [[leadNode]];
	for (let level = 1; level <= maxDepth; level++) {
		const row = tasks.filter((task) => (depth.get(task.id) ?? 0) === level);
		/* 同层排序：按 owner 聚拢，让同一个人的任务在图上相邻——否则
		 * 「谁在并行做几件事」要靠颜色在整层里来回找。无 owner 的排最后。 */
		row.sort((left, right) => {
			const leftOwner = left.ownerName ?? "￿";
			const rightOwner = right.ownerName ?? "￿";
			if (leftOwner !== rightOwner) return leftOwner.localeCompare(rightOwner);
			return left.id.localeCompare(right.id);
		});
		if (row.length > 0) layers.push(row);
	}
	/* lead → 每个「无前置」的任务。用 incoming 为 0 判定而不是 depth===1：
	 * depth 在环兜底后会变动，而「不依赖任何任务」这个事实不随兜底改变。 */
	tasks.forEach((task) => {
		if ((task.blockedBy ?? []).filter((id) => byId.has(id)).length === 0) {
			edges.push({ from: GRAPH_LEAD_ID, to: task.id, kind: "lead" });
		}
	});
	/* 指派边：`reassign` 只可能由 lead 发起（core 里 !lead 直接抛
	 * TEAM_LEAD_REQUIRED），所以「lead → 当前 owner」是可靠推断。
	 * 只看最后一条 reassign，因为早先的指派人选已被覆盖。
	 *
	 * claim 不算指派——那是成员自己认领，画成「lead 指派」会撒谎。 */
	const assigned = new Set();
	tasks.forEach((task) => {
		const history = task.history ?? [];
		for (let index = history.length - 1; index >= 0; index--) {
			if (history[index].action === "reassign") {
				if (task.ownerName !== void 0) assigned.add(task.id);
				break;
			}
		}
	});
	return { byId, edges, layers, depth, assigned };
}
/* 依赖图节点与画布尺寸（px）。
 *
 * 用固定网格 + 绝对定位而不是 CSS flex/grid：边的起止点必须能精确算出来
 * （节点右边缘 → 下一节点左边缘），而 flex 布局的结果要等浏览器排版完
 * 才能量，首帧会画出错位的线。固定尺寸让坐标在渲染前就是确定的。 */
const GRAPH_NODE_W = 168;
const GRAPH_NODE_H = 56;
/* 依赖图。节点按层摆放，层间连线；依赖边从左指向右，指派边用虚线，
 * 有写冲突的任务描红边。 */
/* 缩放范围与步长。下限 0.4 让大图能一眼看全，上限 2.5 够读清单个节点；
 * 再大只会让字体发虚（HTML 节点的 scale 是位图放大）。 */
const GRAPH_ZOOM_MIN = 0.4;
const GRAPH_ZOOM_MAX = 2.5;
const GRAPH_ZOOM_STEP = 1.2;
/* 主布局轴：`vertical` 时层自上而下排（默认），`horizontal` 时层自左而
 * 右排。两条轴用的节点尺寸与间距都不同——纵向时同层节点并排，横向间隔
 * 要给得比纵向大（卡片高 56px，并排时间隔 14px 会挤，纵向堆叠时 14px
 * 才够）；而层间距反过来，纵向堆叠需要更大的层间空隙让连线不打架。 */
const GRAPH_AXIS = {
	vertical: { layerGap: 72, laneGap: 16 },
	horizontal: { layerGap: 64, laneGap: 14 }
};
function TeamBoardGraph({ tasks, t, onOpen, selectedName }) {
	const model = useMemo(() => teamBoardGraphModel(tasks), [tasks]);
	const [vertical, setVertical] = useState(true);
	const axis = vertical ? GRAPH_AXIS.vertical : GRAPH_AXIS.horizontal;
	/* 层数 = 主轴方向的"行数"，同层最多节点数 = 副轴方向的"列数"。 */
	const laneCount = Math.max(1, ...model.layers.map((row) => row.length));
	const layerSpan = model.layers.length * GRAPH_NODE_H + Math.max(0, model.layers.length - 1) * axis.layerGap;
	const laneSpan = laneCount * GRAPH_NODE_W + Math.max(0, laneCount - 1) * axis.laneGap;
	/* 纵向：层向下展开，同层节点横向并排 → 宽 = 副轴跨度，高 = 主轴跨度。
	 * 横向：层向右展开，同层节点纵向堆叠 → 两者互换。 */
	const width = vertical ? laneSpan : layerSpan;
	const height = vertical ? layerSpan : laneSpan;
	/* 节点坐标：主轴由层号决定，副轴由同层内序号决定；副轴整体居中，
	 * 让每层围绕画布中线排布，边不会全挤在一侧。 */
	const positions = new Map();
	model.layers.forEach((row, level) => {
		const offset = (laneSpan - (row.length * GRAPH_NODE_W + Math.max(0, row.length - 1) * axis.laneGap)) / 2;
		const along = level * (GRAPH_NODE_H + axis.layerGap);
		row.forEach((task, index) => {
			const across = offset + index * (GRAPH_NODE_W + axis.laneGap);
			positions.set(task.id, vertical ? { x: across, y: along } : { x: along, y: across });
		});
	});
	/* 缩放/平移只用 CSS transform 施加在画布上，不改 positions。
	 * 这样 SVG 与节点的坐标一次算好就不再变，边永远连在正确的位置上
	 * ——如果去改 positions 本身，每次缩放都要重算全部边，且浮点误差
	 * 会让线头逐渐从节点上滑开。 */
	const scrollRef = useRef(null);
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const dragRef = useRef(void 0);
	/* 拖动阈值：小于它算点击（节点要能点开），超过才进入平移。
	 * 没有这个阈值，任何一次带 1px 抖动的点击都会变成"拖了一下"，
	 * 于是任务详情永远打不开。 */
	const dragMovedRef = useRef(false);
	/* 以指针位置为锚点缩放：让指针下的那个点保持在指针下，而不是朝
	 * 容器中心缩放——后者在小窗口里会让人找不到刚看的位置。
	 *
	 * 注意这里用 zoom/pan 的当前值（来自闭包）而不是 setZoom(updater)
	 * 里做嵌套 setPan：在 updater 内部触发另一个 setState 违反 React
	 * 「updater 必须是纯函数」的约定，同一事件里连续触发时（滚轮会连发
	 * 多次）读到的还是旧值，补偿量会算错。 */
	const zoomAt = (factor, clientX, clientY) => {
		const node = scrollRef.current;
		const box = node?.getBoundingClientRect();
		if (box === void 0 || node === null) return;
		const next = Math.max(GRAPH_ZOOM_MIN, Math.min(GRAPH_ZOOM_MAX, zoom * factor));
		/* 实际生效的比例可能与请求的不同（已到上下限），必须用真实比例
		 * 算补偿，否则到边界后继续滚会让画面持续平移。 */
		const applied = next / zoom;
		if (applied === 1) return;
		const originX = clientX - box.left + node.scrollLeft;
		const originY = clientY - box.top + node.scrollTop;
		setZoom(next);
		setPan({
			x: originX - (originX - pan.x) * applied,
			y: originY - (originY - pan.y) * applied
		});
	};
	const onWheel = (event) => {
		/* 只拦截滚动来缩放；不 preventDefault 的话滚轮会同时滚动容器
		 * 和缩放，画面会跳。 */
		event.preventDefault();
		zoomAt(event.deltaY < 0 ? GRAPH_ZOOM_STEP : 1 / GRAPH_ZOOM_STEP, event.clientX, event.clientY);
	};
	/* wheel 必须用原生监听器加 `{ passive: false }`：React 的事件系统
	 * 对 wheel 注册的是 passive 监听，在里面调 preventDefault() 会被
	 * 浏览器忽略并打一条控制台警告，结果是缩放与容器滚动同时发生。 */
	useEffect(() => {
		const node = scrollRef.current;
		if (node === null) return;
		const handler = (event) => onWheel(event);
		node.addEventListener("wheel", handler, { passive: false });
		return () => node.removeEventListener("wheel", handler);
	}, [zoom, pan]);
	const onPointerDown = (event) => {
		/* 只处理左键/触摸：右键要留给浏览器菜单。 */
		if (event.button !== void 0 && event.button !== 0) return;
		dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
		dragMovedRef.current = false;
		/* 指针按下在**节点上**时绝不能 setPointerCapture。
		 *
		 * 捕获后浏览器把后续 pointer 事件整体重定向到捕获元素（这里是
		 * 滚动画布），click 的目标也随之变成画布——节点上的 onClick
		 * 根本不会触发，于是「点卡片没反应」。空白处按下才捕获，
		 * 拖动平移仍然正常（节点本来就不参与拖动）。 */
		const hitNode = typeof event.target?.closest === "function" && event.target.closest(`.${board.graphNode}`) !== null;
		if (hitNode) return;
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const onPointerMove = (event) => {
		const drag = dragRef.current;
		if (drag === void 0) return;
		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		if (!dragMovedRef.current && Math.abs(dx) + Math.abs(dy) < 4) return;
		dragMovedRef.current = true;
		setPan({ x: drag.panX + dx, y: drag.panY + dy });
	};
	const endDrag = (event) => {
		if (dragRef.current === void 0) return;
		dragRef.current = void 0;
		event.currentTarget.releasePointerCapture?.(event.pointerId);
		/* 必须延后一拍再清「本次发生过拖动」这个标记。
		 *
		 * 浏览器的事件顺序是同一次手势里 pointerup 先于 click，而节点上的
		 * onClick 正是靠这个标记决定要不要吞掉点击。如果在这里直接清掉，
		 * onClick 读到的永远是 false，拖动之后"误开详情"；反过来若干脆
		 * 不清，拖动过一次之后所有点击都会被永久吞掉——节点再也打不开。
		 * 放到下一个宏任务里清，两个问题都不存在。 */
		setTimeout(() => { dragMovedRef.current = false; }, 0);
	};
	const reset = () => {
		setZoom(1);
		setPan({ x: 0, y: 0 });
	};
	/* 冲突任务集合：两侧都 in_progress 才算（与冲突横幅同一口径）。 */
	const conflicting = useMemo(() => {
		const set = new Set();
		teamBoardConflicts(tasks).pairs.forEach((pair) => {
			set.add(pair.left.id);
			set.add(pair.right.id);
		});
		return set;
	}, [tasks]);
	/* 边的路径：三次贝塞尔，控制点沿主轴外推半个层间距，让线从节点
	 * 「下游那一侧」平直地进出。
	 *
	 * 纵向时是下缘中点 → 上缘中点（垂直外推），横向时是右缘中点 →
	 * 左缘中点（水平外推）。进出边必须随方向换：纵向布局下若仍从
	 * 右缘进出，线会从卡片侧面横着甩出去再拐回来，像绕路。 */
	const pathOf = (edge) => {
		const from = positions.get(edge.from);
		const to = positions.get(edge.to);
		if (from === void 0 || to === void 0) return "";
		if (vertical) {
			const x1 = from.x + GRAPH_NODE_W / 2;
			const y1 = from.y + GRAPH_NODE_H;
			const x2 = to.x + GRAPH_NODE_W / 2;
			const y2 = to.y;
			const bend = Math.max(16, (y2 - y1) / 2);
			return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
		}
		const x1 = from.x + GRAPH_NODE_W;
		const y1 = from.y + GRAPH_NODE_H / 2;
		const x2 = to.x;
		const y2 = to.y + GRAPH_NODE_H / 2;
		const bend = Math.max(16, (x2 - x1) / 2);
		return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
	};
	const nodeColorOf = (task) => teamBoardTaskColor(task.status);
	/* 点阵背景随平移走、随缩放缩放：把网格偏移量绑到 pan 上，缩放时
	 * 用 background-size 同比放大，于是网格看起来"贴在地面上"而不是
	 * 固定在屏幕上——后者在拖动时会显出内容在格子间滑动的割裂感。 */
	const dotSize = 22 * zoom;
	return jsxs("div", {
		className: board.graphWrap,
		children: [
			jsxs("div", {
				className: board.graphTools,
				children: [
					jsx("button", {
						type: "button",
						className: board.graphToolBtn,
						onClick: () => zoomAt(GRAPH_ZOOM_STEP, (scrollRef.current?.getBoundingClientRect().left ?? 0) + 200, (scrollRef.current?.getBoundingClientRect().top ?? 0) + 150),
						"aria-label": t("board.graphZoomIn"),
						title: t("board.graphZoomIn"),
						children: "+"
					}),
					jsx("button", {
						type: "button",
						className: board.graphToolBtn,
						onClick: () => zoomAt(1 / GRAPH_ZOOM_STEP, (scrollRef.current?.getBoundingClientRect().left ?? 0) + 200, (scrollRef.current?.getBoundingClientRect().top ?? 0) + 150),
						"aria-label": t("board.graphZoomOut"),
						title: t("board.graphZoomOut"),
						children: "−"
					}),
					jsx("button", {
						type: "button",
						className: board.graphToolBtn,
						onClick: reset,
						"aria-label": t("board.graphReset"),
						title: t("board.graphReset"),
						children: "⟲"
					}),
					/* 切换主轴方向。按钮上的箭头指向"按下去之后的方向"，
					 * 而不是"当前方向"——后者会让人以为点了会切到别处。 */
					jsx("button", {
						type: "button",
						className: board.graphToolBtn,
						onClick: () => {
							setVertical(!vertical);
							/* 换轴后旧视角没有意义：画布宽高互换，原来的缩放/平移
							 * 会让画面停在空白处。重置到干净状态。 */
							reset();
						},
						"aria-label": t("board.graphFlip"),
						"aria-pressed": !vertical,
						title: vertical ? t("board.graphFlipToHorizontal") : t("board.graphFlipToVertical"),
						children: vertical ? "⇄" : "⇅"
					}),
					jsx("span", {
						className: board.graphZoomLabel,
						children: `${Math.round(zoom * 100)}%`
					})
				]
			}),
			jsx("div", {
				ref: scrollRef,
				className: board.graphScroll,
				/* 拖动时改成 grab/grabbing：光标是唯一的"这里可以拖"的提示，
				 * 没有它用户不会想到空白处能拖。 */
				/* 拖动时改成 grabbing 由 CSS :active 处理——用 dragRef.current
				 * 判断不会生效，ref 变化不触发重渲染，光标永远停在 grab。 */
				onPointerDown,
				onPointerMove,
				onPointerUp: endDrag,
				onPointerCancel: endDrag,
				/* 双击复位：缩放/平移后想回到初始视角是最常见的一步，
				 * 按钮在左上角，双击画布更顺手。 */
				onDoubleClick: reset,
				children: jsxs("div", {
					className: board.graph,
					style: {
						width: `${width}px`,
						height: `${height}px`,
						transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
						/* transform-origin 必须是左上角：以中心为原点是默认值，
						 * 那样 translate 的像素与 scale 的倍率会互相耦合，
						 * 指针锚点的补偿公式就不再成立。 */
						transformOrigin: "0 0",
						backgroundPosition: `${pan.x}px ${pan.y}px`,
						backgroundSize: `${dotSize}px ${dotSize}px`
					},
					children: [
						/* SVG 覆盖整张画布，负责全部连线；节点是 HTML，浮在它上面。
						 * 顺序要紧：SVG 在前，卡片才能盖住线头。 */
						jsx("svg", {
							className: board.graphEdges,
							width: width,
							height: height,
							"aria-hidden": "true",
							children: [
								/* 三类边分开画，各自一个样式：
								 * 依赖边（灰实线）、lead 派发边（灰虚线）、冲突边（红粗线）。
								 * 拆成三个 map 而不是在一个 map 里按条件给 class，是因为
								 * SVG 的绘制顺序就是数组顺序——要把红色压在最上面。
								 * 冲突判定只对真实依赖边生效：lead 边两端里有一端是
								 * 合成节点，它不属于任何写冲突。 */
								model.edges.filter((edge) => edge.kind !== "lead" && !(conflicting.has(edge.from) && conflicting.has(edge.to))).map((edge) => jsx("path", {
									className: board.graphEdge,
									d: pathOf(edge)
								}, `${edge.from}->${edge.to}`)),
								model.edges.filter((edge) => edge.kind === "lead").map((edge) => jsx("path", {
									className: board.graphEdgeLead,
									d: pathOf(edge)
								}, `lead-${edge.to}`)),
								model.edges.filter((edge) => edge.kind !== "lead" && conflicting.has(edge.from) && conflicting.has(edge.to)).map((edge) => jsx("path", {
									className: board.graphEdgeConflict,
									d: pathOf(edge)
								}, `c-${edge.from}->${edge.to}`)),
								/* 箭头标记放在每条边末端。独立 path 而不是 SVG marker：
								 * marker 的朝向要按路径切线算，在纵向/横向两种布局
								 * 下都得重算，而直接画三角形只有一组坐标要换。 */
								model.edges.map((edge) => {
									const to = positions.get(edge.to);
									if (to === void 0) return null;
									const midX = to.x + GRAPH_NODE_W / 2;
									const midY = to.y + GRAPH_NODE_H / 2;
									/* 纵向：箭头在目标上缘、朝下。 */
									const d = vertical
										? `M ${midX - 4.5} ${to.y - 9} L ${midX} ${to.y} L ${midX + 4.5} ${to.y - 9}`
										: `M ${to.x - 9} ${midY - 4.5} L ${to.x} ${midY} L ${to.x - 9} ${midY + 4.5}`;
									return jsx("path", {
										className: conflicting.has(edge.from) && conflicting.has(edge.to)
											? board.graphArrowConflict
											: board.graphArrow,
										d
									}, `a-${edge.from}->${edge.to}`);
								})
							]
						}),
						model.layers.flatMap((row) => row.map((task) => {
							const at = positions.get(task.id);
							/* lead 根节点不是任务：用非交互的 div 渲染，不响应点击
							 * （点了打开「__lead__ 任务详情」是个 bug），也没有
							 * 状态点/owner——它代表这一轮调度的起点。 */
							if (task.synthetic === true) {
								return jsx("div", {
									className: board.graphLead,
									style: { left: `${at.x}px`, top: `${at.y}px` },
									children: jsx("span", {
										className: board.graphLeadLabel,
										children: t("board.graphLeadRoot")
									})
								}, task.id);
							}
							const classes = [board.graphNode];
							if (conflicting.has(task.id)) classes.push(board.graphNodeConflict);
							if (selectedName !== void 0 && task.ownerName === selectedName) classes.push(board.graphNodePicked);
							return jsxs("button", {
								type: "button",
								className: classes.join(" "),
								style: {
									left: `${at.x}px`,
									top: `${at.y}px`,
									["--mtb-accent"]: nodeColorOf(task)
								},
								/* 节点上的指针事件不冒泡到画布：画布的
								 * onPointerDown 会 setPointerCapture，捕获后
								 * click 目标变成画布，节点的 onClick 就废了。 */
								onPointerDown: (event) => event.stopPropagation(),
								onClick: () => {
									if (dragMovedRef.current) return;
									onOpen(task.id);
								},
								title: task.subject,
								children: [
									jsxs("span", {
										className: board.graphNodeHead,
										children: [
											jsx(StateDot, { state: taskDotState(task) }),
											jsx("span", {
												className: board.graphNodeId,
												children: task.id
											}),
											/* 被 lead 指派的任务打一个标：与「自己认领」区分开，
											 * 这正是用户要看的「谁指派给谁」。 */
											model.assigned.has(task.id) ? jsx("span", {
												className: board.graphNodeAssign,
												title: t("board.graphAssigned"),
												children: "⇢"
											}) : null
										]
									}),
									jsx("span", {
										className: board.graphNodeSubject,
										children: task.subject
									}),
									jsxs("span", {
										className: board.graphNodeMeta,
										children: [
											t(statusKey(task.status)),
											task.ownerName !== void 0 ? ` · ${task.ownerName}` : ""
										]
									})
								]
							}, task.id);
						}))
					]
				})
			})
		]
	});
}
/* wire 视图只带 writeScopeWarnings（形如 "write scopes overlap with task-3"），
 * 结构化的 conflicts 数组没上投影。警告文案由 core 的
 * detectWriteScopeConflict 生成、格式固定，所以从文本里回抽对方 taskId 是
 * 可靠的。抽不出 id 的警告（未来文案变更）退化成文本展示，不丢信息。 */
function teamBoardConflictPairs(task) {
	return (task.writeScopeWarnings ?? []).map((warning) => {
		const matched = /overlap with (\S+)$/.exec(warning);
		return { warning, otherId: matched?.[1] };
	});
}
/* 汇总全板的写冲突：只在「双方都 in_progress」时才算风险——pending 任务
 * 还没开工，它和 running 任务的范围重叠只是预期中的排队。同一 owner 内部
 * 的重叠也不算（core 的 conflicts 剔除 sameOwner 是同一个道理）。 */
function teamBoardConflicts(tasks) {
	const running = tasks.filter((task) => task.status === "in_progress");
	const pairs = [];
	const orphans = [];
	const seen = new Set();
	running.forEach((task) => {
		teamBoardConflictPairs(task).forEach(({ warning, otherId }) => {
			const other = running.find((candidate) => candidate.id === otherId);
			/* 回抽不到 id（core 文案变更）时不能静默丢掉——那会让告警条
			 * 漏报真实冲突。降级成原样文本，信息不丢。 */
			if (other === void 0) {
				if (!seen.has(warning)) {
					seen.add(warning);
					orphans.push({ text: warning, taskId: task.id });
				}
				return;
			}
			if (task.ownerName !== void 0 && task.ownerName === other.ownerName) return;
			const key = [task.id, other.id].sort().join("|");
			if (seen.has(key)) return;
			seen.add(key);
			pairs.push({ left: task, right: other, warning });
		});
	});
	return { pairs, orphans };
}
/* 骨架屏：只在冷启动（从未拿到过投影 + list 仍 pending）时出现。用固定
 * 的骨架条数而不是"猜"真实数量——猜错会让骨架→真实内容的形状突变。 */
function TeamBoardSkeleton({ t }) {
	return jsxs("div", {
		className: board.skeleton,
		role: "status",
		"aria-label": t("board.loadingBoard"),
		children: [
			[0, 1, 2].map((row) => jsxs("div", {
				className: board.skelCard,
				children: [
					jsx("span", { className: board.skelAvatar }),
					jsxs("span", {
						className: board.skelLines,
						children: [
							jsx("span", { className: `${board.skelLine} ${board.skelLineWide}` }),
							jsx("span", { className: `${board.skelLine} ${board.skelLineNarrow}` })
						]
					})
				]
			}, row))
		]
	});
}
/* 空态不是「没数据」的陈述，而是下一步的动作提示——面板本身不能创建
 * 任务（创建走对话里的工具），所以指路就是它能给的最有用信息。 */
function TeamBoardEmpty({ title, hint }) {
	return jsxs("div", {
		className: board.emptyBox,
		children: [
			jsx("span", { className: board.emptyTitle, children: title }),
			jsx("span", { className: board.emptyHint, children: hint })
		]
	});
}
/* 面板级写冲突告警：单张任务卡上的角标（C）只有点开才看得到，而写冲突
 * 是「两个 running 任务会互相覆盖文件」——这是唯一带风险性质的状态，
 * 必须在自己不主动找的情况下也被看见。默认展开（风险不折叠），点标题
 * 可收起。 */
function TeamBoardConflictBanner({ conflicts, orphans, onOpenTask, t }) {
	const [open, setOpen] = useState(true);
	/* 去重后的任务数，不是「对数」——3 个任务互相覆盖只有 3 个任务要处理，
	 * 报成 3 对会让 lead 以为有 6 处问题。 */
	const taskIds = new Set();
	conflicts.forEach(({ left, right }) => {
		taskIds.add(left.id);
		taskIds.add(right.id);
	});
	orphans.forEach((entry) => taskIds.add(entry.taskId));
	if (taskIds.size === 0) return null;
	return jsxs("div", {
		className: board.warnBanner,
		role: "alert",
		children: [
			jsxs("button", {
				type: "button",
				className: board.warnHead,
				"aria-expanded": open,
				onClick: () => setOpen(!open),
				children: [
					jsx(StateDot, { state: "warning" }),
					jsx("span", { className: board.warnText, children: t("board.conflictBanner", { count: taskIds.size }) }),
					jsx("span", { className: board.chevron, style: { transform: open ? "none" : "rotate(-90deg)" }, children: "▾" })
				]
			}),
			open ? jsxs("div", {
				className: board.warnList,
				children: [conflicts.map(({ left, right }) => jsxs("div", {
					className: board.warnRow,
					children: [
						jsx("button", {
							type: "button",
							className: board.warnLink,
							onClick: () => onOpenTask(left.id),
							children: left.id
						}),
						jsx("span", { className: board.warnVs, children: "×" }),
						jsx("button", {
							type: "button",
							className: board.warnLink,
							onClick: () => onOpenTask(right.id),
							children: right.id
						}),
						jsx("span", { className: board.warnSubjects, children: [left.ownerName, right.ownerName].filter((name) => name !== void 0).join(" / ") })
					]
				}, `${left.id}|${right.id}`)), orphans.map((entry) => jsxs("div", {
					className: board.warnRow,
					children: [
						jsx("button", {
							type: "button",
							className: board.warnLink,
							onClick: () => onOpenTask(entry.taskId),
							children: entry.taskId
						}),
						jsx("span", { className: board.warnSubjects, children: entry.text })
					]
				}, entry.text))]
			}) : null
		]
	});
}
/* 任务视图的工具栏：左半是「列表 / 依赖图」切换，右半是排序（仅列表用）。
 *
 * 两段共用一个 chip 样式但与排序语义不同——排序只在列表里有意义（图层
 * 的位置由依赖决定，不能按优先级重排，否则箭头会乱指），所以切到依赖图
 * 时排序段落自动隐藏，而不是留一排点了没反应的按钮。 */
function TeamBoardTaskToolbar({ taskView, setTaskView, taskSort, setTaskSort, t }) {
	const sorts = ["default", "priority", "updated"];
	return jsxs("div", {
		className: board.filterBar,
		children: [
			jsx("div", {
				className: board.filterGroup,
				role: "group",
				"aria-label": t("board.taskView"),
				children: ["list", "graph"].map((option) => jsx("button", {
					type: "button",
					className: taskView === option ? `${board.filterChip} ${board.filterChipActive}` : board.filterChip,
					"aria-pressed": taskView === option,
					onClick: () => setTaskView(option),
					children: t(`board.taskView.${option}`)
				}, option))
			}),
			taskView === "list" ? jsx("div", {
				className: board.filterGroup,
				role: "group",
				"aria-label": t("board.sortBy"),
				children: sorts.map((option) => jsx("button", {
					type: "button",
					className: taskSort === option ? `${board.filterChip} ${board.filterChipActive}` : board.filterChip,
					"aria-pressed": taskSort === option,
					onClick: () => setTaskSort(option),
					children: t(`board.sort.${option}`)
				}, option))
			}) : null
		]
	});
}
function TeamBoardGroup({ title, count, color, children }) {
	const [open, setOpen] = useState(true);
	return jsxs("section", {
		children: [
			jsxs("button", {
				type: "button",
				className: board.groupTitle,
				onClick: () => setOpen(!open),
				children: [
					color !== void 0 ? jsx("span", { className: board.groupDot, style: { background: color } }) : null,
					title,
					jsx("span", { className: board.groupCount, children: count }),
					jsx("span", { className: board.chevron, style: { transform: open ? "none" : "rotate(-90deg)" }, children: "▾" })
				]
			}),
			open ? children : null
		]
	});
}
const TEAM_BOARD_MEMBER_GROUPS = ["running", "idle", "unloaded", "inactive", "provisioning", "failed", "released"];
const TEAM_BOARD_TASK_GROUPS = ["in_progress", "ready", "blocked", "completed"];
function TeamBoard({ sessionId, sessions, openTeammate, onError, t }) {
	const [view, setView] = useState("members");
	/* 任务详情导航栈：栈里存经过的任务 id，栈顶就是当前详情页。
	 *
	 * 用栈而不是单个 id，是因为详情页里的「依赖/阻塞」行能互相跳转
	 * （task-3 → task-2 → task-4…），用户会连跳好几层。单值只记住
	 * 「现在是哪个」，跳转即覆盖来源，用户回不去。栈让「返回上个任务」
	 * 成为确定性的操作，而不是靠猜。
	 *
	 * 空栈 = 在任务列表页。 */
	const [taskStack, setTaskStack] = useState([]);
	const selectedTaskId = taskStack.length > 0 ? taskStack[taskStack.length - 1] : void 0;
	/* 详情页是从哪个 tab 进来的。必须在切换视图之前记下——切完之后
	 * view 已经是 tasks，来源就丢失了。用于「返回」时把用户送回原处。 */
	const [taskOrigin, setTaskOrigin] = useState(void 0);
	/* 从列表页进入：栈重置为单元素——列表页点开谁就是谁的「根」，
	 * 之前的路径不该保留（否则从别的任务跳回列表再点开，会带上旧历史）。
	 * 只动栈、不动视图：调用它的地方都已经在 tasks 视图里。 */
	const openTaskFromList = (id) => {
		setTaskOrigin(void 0);
		setTaskStack([id]);
	};
	/* 跨 tab 跳转（成员卡片的任务行、冲突横幅）：除了压栈还必须切到
	 * tasks 视图。只压栈的话视图还停在 members，用户看到的是「点了没
	 * 反应」——数据变了但渲染分支没变。 */
	const openTaskFromOtherTab = (id) => {
		setTaskOrigin(view);
		setView("tasks");
		setTaskStack([id]);
	};
	/* 详情页内跳转：压栈。 */
	const pushTask = (id) => setTaskStack((stack) => (stack[stack.length - 1] === id ? stack : [...stack, id]));
	/* 返回：清空整条栈；若这次是跨 tab 跳进来的，还要把视图还回去，
	 * 否则用户被丢在任务列表而他的上下文还在原面板上。 */
	const backToList = () => {
		setTaskStack([]);
		if (taskOrigin !== void 0) {
			setView(taskOrigin);
			setTaskOrigin(void 0);
		}
	};
	/* 返回上个任务：弹一层；已经在根上（长度 1）时返回列表——与「返回
	 * 任务列表」等价，这是唯一不会让用户点到一个空操作的降级方式。 */
	const popTask = () => setTaskStack((stack) => stack.slice(0, -1));
	const [taskSort, setTaskSort] = useState("default");
	/* 任务视图形态：列表（按状态分组）或依赖图（按依赖分层）。
	 * 不持久化——图是「需要时看一眼」的诊断视图，列表才是日常工作面。 */
	const [taskView, setTaskView] = useState("list");
	/* 选中的成员（会话 id）。跨 tab 共享：任务面板只显示他名下的任务、
	 * 对话记录只显示与他相关的消息。再点一次同一张卡取消选中。 */
	const [selectedMemberId, setSelectedMemberId] = useState(void 0);
	const list = useTeamBoardSessions(sessions);
	/* 板子只活在 lead Session 的 projection 上。lead 解析走兜底链
	 * （byId.subagent → binding → 成员名单反查），队友会话侧 byId 快照
	 * 常缺 subagent 地址，单一路径会解析失败退回自身会话，导致
	 * 「从队友打开只剩 lead」。 */
	const leadId = useMemo(() => teamBoardLeadId(sessionId, list), [sessionId, list]);
	/* 投影偶尔瞬断（切换会话/订阅竞态）时保留上一次非空 team 视图，
	 * 面板不闪「暂无数据」；leadId 变化才重置。 */
	const teamRef = useRef(void 0);
	const previousLeadRef = useRef(leadId);
	if (previousLeadRef.current !== leadId) {
		previousLeadRef.current = leadId;
		teamRef.current = void 0;
	}
	const currentTeam = list.projectionsBySession[leadId]?.values.agentTeam;
	teamRef.current = teamBoardLastDefined(teamRef.current, currentTeam);
	const team = teamRef.current;
	/* 首帧从没拿到过投影、list 还在 pending 时给骨架，而不是直接跳
	 * 「暂无数据」再被真实内容替换——那一下跳变比等 100ms 更刺眼。
	 * team 一旦存在过就永不再回骨架（teamRef 保留）。 */
	const coldStart = team === void 0 && list.phase === "pending";
	const members = team?.members ?? [];
	const messages = team?.messages ?? [];
	const tasks = (team?.tasks ?? []).filter((task) => task.status !== "deleted");
	/* 选中成员的会话 id → 名字。任务按 ownerName 归属、消息按 from/to
	 * 归属，两边都只认名字，所以要用名字做匹配前先解析出来。成员被移除
	 * 后选中态失效，退回未选中而不是显示空列表。 */
	const selectedMember = members.find((member) => (member.name ?? member.id) === selectedMemberId);
	const selectedName = selectedMemberId;
	const toggleMember = (name) => setSelectedMemberId((current) => current === name ? void 0 : name);
	/* 每成员名下的任务清单（不含已删除），供成员卡片的展开列表使用。
	 * owner 归并用 ownerName（wire 视图不携带 owner id）。 */
	const tasksByOwner = {};
	/* 每成员「运行中或最近」的任务视图：卡片底部显示标题+摘要。 */
	const taskByOwner = {};
	tasks.forEach((task) => {
		if (task.ownerName === void 0) return;
		(tasksByOwner[task.ownerName] ??= []).push(task);
		if (task.status === "in_progress") taskByOwner[task.ownerName] = task;
		else if (taskByOwner[task.ownerName] === void 0 && task.status !== "deleted") taskByOwner[task.ownerName] = task;
	});
	/* 排序：进行中在前，其余按更新时间新→旧。列表第一项与卡片摘要行
	 * 是同一个任务，展开时视觉连续。 */
	Object.values(tasksByOwner).forEach((rows) => rows.sort((left, right) => {
		const rank = (task) => task.status === "in_progress" ? 0 : task.status === "pending" ? 1 : 2;
		const byRank = rank(left) - rank(right);
		if (byRank !== 0) return byRank;
		return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
	}));
	const membersByStatus = {};
	members.forEach((member) => {
		/* 分组必须与行内展示同一套推导：active 相位下投影 status 常停在
		 * inactive，需按 byId[id].running 兜底判 running，否则运行中的
		 * 队员会被归进「未运行」组。 */
		const running = list.byId[member.id]?.running;
		const status = teamBoardMemberStatus(member, running);
		(membersByStatus[status] ||= []).push(member);
	});
	const tasksByGroup = {};
	/* 组内排序：默认保持投影顺序（= 创建顺序，人已经熟悉了）；优先级
	 * 排序把 high 提上来，更新时间排序把最近动的提上来。优先级值来自
	 * 任务的自由字符串（高/中/低 会归一成 high/medium/low），所以先查
	 * 已知档位表，未知值排最后而不是当字符串比大小。 */
	const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
	const sortTasks = (list, mode) => {
		if (mode === "priority") return [...list].sort((left, right) => (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9));
		if (mode === "updated") return [...list].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
		return list;
	};
	tasks.forEach((task) => {
		const group = teamBoardTaskGroup(task);
		if (group !== null) (tasksByGroup[group] ||= []).push(task);
	});
	TEAM_BOARD_TASK_GROUPS.forEach((group) => {
		if (tasksByGroup[group] !== void 0) tasksByGroup[group] = sortTasks(tasksByGroup[group], taskSort);
	});
	const boardConflicts = teamBoardConflicts(tasks);
	/* 成员卡片 taskCount/task 按 ownerName 键取值（member.name 与
	 * task.ownerName 同域；id 键作旧投影兜底）。 */
	/* 成员卡片 taskList/taskOf 按 ownerName 键取值（member.name 与
	 * task.ownerName 同域；id 键作旧投影兜底）。 */
	const taskListOf = (member) => tasksByOwner[member.name] ?? tasksByOwner[member.id] ?? [];
	const taskOf = (member) => taskByOwner[member.name] ?? taskByOwner[member.id];
	return jsxs("div", {
		className: board.root,
		children: [
			jsxs("div", {
				className: board.tabs,
				children: [
					jsxs("button", {
						type: "button",
						className: view === "members" ? `${board.tab} ${board.tabActive}` : board.tab,
						onClick: () => setView("members"),
						children: [
							t("board.membersTab"),
							jsx("span", { className: board.count, children: members.length })
						]
					}),
					jsxs("button", {
						type: "button",
						className: view === "tasks" ? `${board.tab} ${board.tabActive}` : board.tab,
						onClick: () => { setView("tasks"); backToList(); },
						children: [
							t("board.tasksTab"),
							jsx("span", { className: board.count, children: tasks.length })
						]
					}),
					jsxs("button", {
						type: "button",
						className: view === "chat" ? `${board.tab} ${board.tabActive}` : board.tab,
						onClick: () => setView("chat"),
						children: [
							t("board.chatTab"),
							jsx("span", { className: board.count, children: messages.length })
						]
					})
				]
			}),
			/* 选中态必须始终可见且可清除：筛选是隐式的作用域变更，如果只在
			 * 卡片和 tab 内容里体现，用户会以为"数据没了"。 */
			selectedName !== void 0 ? jsxs("div", {
				className: board.selBar,
				role: "status",
				children: [
					jsx("span", {
						className: board.selChip,
						/* 已释放的队友不在名单上（selectedMember 为 undefined），
						 * 但消息里仍有它，选中态要照常显示，只是没有状态色。 */
						style: { ["--mtb-accent"]: selectedMember !== void 0 ? teamBoardStatusColor(teamBoardMemberStatus(selectedMember, list.byId[selectedMember.id]?.running)) : void 0 },
						children: t("board.selected", { name: selectedName })
					}),
					jsx("button", {
						type: "button",
						className: board.selClear,
						onClick: () => setSelectedMemberId(void 0),
						children: t("board.clearSelection")
					})
				]
			}) : null,
			jsx(TeamBoardConflictBanner, {
				conflicts: boardConflicts.pairs,
				orphans: boardConflicts.orphans,
				onOpenTask: openTaskFromOtherTab,
				t
			}),
			jsx("div", {
				/* 对话 tab 与任务列表都自己管滚动（时间线要固定），所以外层
				 * body 在这两种视图下不能也滚，否则嵌套滚动会把 rail 一起
				 * 带走。任务详情子页仍用外层滚动——它没有 rail，且内容高度
				 * 不可预期。 */
				className: view === "chat" || (view === "tasks" && selectedTaskId === void 0)
					? `${board.body} ${board.bodyChat}`
					: board.body,
				children: coldStart
					? jsx(TeamBoardSkeleton, { t })
					: view === "members"
					? members.length === 0
						? jsx(TeamBoardEmpty, {
						title: t("board.emptyMembersTitle"),
						hint: t("board.emptyMembersHint")
					})
						: TEAM_BOARD_MEMBER_GROUPS.filter((group) => membersByStatus[group]?.length > 0).map((group) =>
							jsx(TeamBoardGroup, {
								title: t(`board.memberGroups.${group}`),
								count: membersByStatus[group].length,
								color: teamBoardStatusColor(group),
								children: jsx("div", {
									className: board.roster,
									children: membersByStatus[group].map((member) =>
										jsx(TeamBoardMemberRow, {
											member,
											sessionId: leadId,
											sessions,
											openTeammate,
											onError,
											t,
											taskList: taskListOf(member),
											task: taskOf(member),
											onOpenTask: openTaskFromOtherTab,
											updatedAt: list.byId[member.id]?.updatedAt,
											selected: selectedMemberId !== void 0 && (member.name ?? member.id) === selectedMemberId,
											onSelect: toggleMember
										}, member.id))
								})
							}, group))
					: view === "chat"
						? jsx(TeamBoardChat, { messages, members, t, selectedName, onSelectMember: toggleMember, sessions })
						: selectedTaskId !== void 0
							? (() => {
								const selected = tasks.find((task) => task.id === selectedTaskId);
								/* 栈顶任务从板上消失（被删/被过滤）时回落到列表页；
								 * 注意这时要清空整条栈，否则栈里留着已不存在的 id，
								 * 「返回上个任务」会弹到一个同样无效的层。 */
								if (selected === void 0) return jsxs(Fragment, { children: [
									jsx(TeamBoardTaskToolbar, { taskView, setTaskView, taskSort, setTaskSort, t }),
									taskView === "graph"
										? jsx(TeamBoardGraph, { tasks, t, onOpen: openTaskFromList, selectedName })
										: jsx(TeamBoardTaskList, { tasksByGroup, t, onOpen: openTaskFromList, selectedName })
								] });
								return jsx(TeamBoardTaskDetail, {
									task: selected,
									leadId,
									list,
									/* 左：回到任务列表（清栈）。右：回上一个任务（弹栈），
									 * 栈深 1 时两者等价，都落到列表页。 */
									onBack: backToList,
									/* 从依赖图点进来的，返回目标是「图」而不是「列表」——
									 * taskView 不会被这里改动，所以返回后确实回到图，
									 * 只有按钮文案需要跟着当前视图说。 */
									backLabel: taskView === "graph" ? t("board.backToGraph") : void 0,
									onUp: taskStack.length > 1 ? popTask : void 0,
									onOpen: pushTask,
									openTeammate,
									onError,
									t
								}, selectedTaskId);
							})()
							: jsxs(Fragment, { children: [
								tasks.length > 0 ? jsx(TeamBoardTaskToolbar, { taskView, setTaskView, taskSort, setTaskSort, t }) : null,
								tasks.length === 0
									? jsx(TeamBoardEmpty, {
										title: t("board.emptyTasksTitle"),
										hint: t("board.emptyTasksHint")
									})
									: taskView === "graph"
										? jsx(TeamBoardGraph, { tasks, t, onOpen: openTaskFromList, selectedName })
										: jsx(TeamBoardTaskList, { tasksByGroup, t, onOpen: openTaskFromList, selectedName })
							] })
			})
		]
	});
}
//#endregion

export { TeamBoard }
