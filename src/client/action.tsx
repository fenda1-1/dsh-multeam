// @ts-nocheck — migrated verbatim from the verified bundle; types are tightened incrementally.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { createPortal } from 'react-dom'
import { createPortal as _createPortal } from 'react-dom'
import {
	IconChevronDownOutlineRegular,
	IconUsersOutlineRegular,
	IconUserOutlineRegular,
	StateDot,
	Tag,
	Tooltip,
	useAnchoredPosition,
	useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { action, board } from './styles.js'
import {
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

//#region lib/types/client/TeamAction.js


function memberDotState(status) {
	switch (status) {
		case "running":
		case "provisioning": return "ongoing";
		case "idle": return "idle";
		case "unloaded": return "warning";
		case "failed": return "error";
		case "released": return "done";
	}
}


















function TeamMemberRow({ member, memberCount, sessionId, useSessions, useSessionStatus, openTeammate, onError, t }) {
	const model = useSessions((state) => state.projectionsBySession[member.id]?.values.modelSelection?.next?.model);
	const running = useSessionStatus((state) => state.get(member.id)?.running);
	const summaryRunning = useSessions((state) => state.byId[member.id]?.running);
	/* member.status 是 TeamMemberView 透出的四值 running/idle/unloaded/inactive，
	 * 直接采用而非用 live running boolean 重新折叠——后者会把 idle/unloaded
	 * 全压成 inactive 丢粒度。非 active 成员回落到 phase。running/summaryRunning
	 * 仅作 member.status 缺省时的兜底。 */
	const status = member.phase === "active" ? (member.status ?? ((running ?? summaryRunning) === true ? "running" : "inactive")) : member.phase;
	const isCurrent = member.id === sessionId;
	const highlightCurrent = isCurrent && memberCount > 1;
	const inert = isCurrent || status === "failed" || status === "provisioning";
	return jsx(Tooltip, {
		label: t("open"),
		side: "bottom",
		gap: 4,
		disabled: inert,
		children: jsxs("button", {
			type: "button",
			className: highlightCurrent ? `${action.member} ${action.memberCurrent}` : action.member,
			disabled: inert,
			onClick: () => {
				try {
					openTeammate(sessionId, member.id);
				} catch (reason) {
					onError(String(reason));
				}
			},
			children: [jsx("span", {
				className: action.memberDot,
				children: status === "inactive" || status === "idle" || status === "unloaded" ? jsx(IconUserOutlineRegular, {
					size: 14,
					className: action.inactiveIcon
				}) : jsx(StateDot, { state: memberDotState(status) })
			}), jsxs("span", {
				className: action.memberText,
				children: [
					jsxs("span", {
						className: action.memberName,
						children: [jsx("span", {
							className: action.memberNameText,
							children: member.name
						}), isCurrent && jsx(Tag, {
							tone: "info",
							className: action.currentTag,
							children: t("current")
						})]
					}),
					jsxs("small", { children: [t(memberStatusKey(status)), model !== void 0 && jsx("span", {
						className: action.memberModel,
						children: ` · ${t("model")}: ${model}`
					})] }),
					member.error !== void 0 && jsx("small", {
						className: action.diagnostic,
						children: member.error
					})
				]
			})]
		})
	});
}
/** Task card with a two-line description clamp expanded from a toggle in the meta row. */
function TaskCard({ task, t }) {
	const [expanded, setExpanded] = useState(false);
	const [clamped, setClamped] = useState(false);
	const textRef = useRef(null);
	useLayoutEffect(() => {
		if (expanded) return;
		const paragraph = textRef.current;
		/* v8 ignore next -- the paragraph mounts in the same commit as the effect. */
		if (paragraph === null) return;
		const measure = () => {
			setClamped(paragraph.scrollHeight > paragraph.clientHeight + 1);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(paragraph);
		return () => {
			observer.disconnect();
		};
	}, [task.description, expanded]);
	return jsxs("article", {
		className: action.task,
		children: [
			jsxs("div", {
				className: action.taskTitle,
				children: [jsx("strong", { children: task.subject }), jsxs("span", {
					className: action.taskState,
					children: [jsx(StateDot, { state: taskDotState(task) }), jsx("span", { children: t(statusKey(task.status)) })]
				})]
			}),
			jsx("p", {
				ref: textRef,
				className: expanded ? void 0 : action.clampedDescription,
				children: task.description
			}),
			jsxs("div", {
				className: action.meta,
				children: [
					(clamped || expanded) && jsxs("button", {
						type: "button",
						className: action.expandToggle,
						"aria-expanded": expanded,
						onClick: () => {
							setExpanded((current) => !current);
						},
						children: [t(expanded ? "task.collapse" : "task.expand"), jsx(IconChevronDownOutlineRegular, {
							size: 12,
							className: expanded ? action.expandToggleOpen : void 0
						})]
					}),
					jsx("span", { children: task.id }),
					jsxs("span", { children: [
						t("owner"),
						": ",
						task.ownerName ?? t("unowned")
					] }),
					task.status === "pending" && jsx("span", { children: task.ready ? t("ready") : t("blocked") }),
					task.blockedBy.length > 0 && jsxs("span", { children: [
						t("blockedBy"),
						": ",
						task.blockedBy.join(", ")
					] }),
					task.writeScopes.length > 0 && jsxs("span", { children: [
						t("writeScopes"),
						": ",
						task.writeScopes.join(", ")
					] }),
					task.writeScopeWarnings.map((warning) => jsx("span", {
						className: action.warning,
						children: warning
					}, warning))
				]
			})
		]
	});
}
/** Render the Team roster and read-only task board. */
function TeamAction({ sessionId, useSession, useSessions, useSessionStatus, openTeammate, t }) {
	const [open, setOpen] = useState(false);
	const [error, setError] = useState(null);
	const rootRef = useRef(null);
	const triggerRef = useRef(null);
	const triggerLabelRef = useRef(null);
	const panelRef = useRef(null);
	const position = (0, useAnchoredPosition)({
		open,
		anchorRef: triggerRef,
		panelRef,
		gap: 5,
		margin: 16
	});
	const positioned = position !== null;
	const leadSessionId = useSession((snapshot) => snapshot.subagent?.address.parentSessionId) ?? sessionId;
	const team = useSessions((state) => state.projectionsBySession[leadSessionId]?.values.agentTeam);
	const opening = useSession((snapshot) => snapshot.openState === "loading");
	const listing = useSessions((state) => state.phase === "pending");
	const hoverTimer = useRef(void 0);
	const pinnedRef = useRef(false);
	const cancelHoverChange = () => {
		clearTimeout(hoverTimer.current);
		hoverTimer.current = void 0;
	};
	useEffect(() => {
		cancelHoverChange();
		pinnedRef.current = false;
		setOpen(false);
		setError(null);
	}, [sessionId]);
	useEffect(() => cancelHoverChange, []);
	useLayoutEffect(() => {
		if (open && positioned && pinnedRef.current) panelRef.current?.focus();
	}, [open, positioned]);
	const changeOpen = (next) => {
		cancelHoverChange();
		if (!next) pinnedRef.current = false;
		setOpen(next);
	};
	const scheduleHoverOpen = () => {
		cancelHoverChange();
		if (open) return;
		const label = triggerLabelRef.current;
		/* v8 ignore next -- the label mounts with the trigger that received the hover. */
		if (label === null) return;
		if (getComputedStyle(label).display === "none") return;
		hoverTimer.current = setTimeout(() => {
			hoverTimer.current = void 0;
			changeOpen(true);
		}, 150);
	};
	const scheduleHoverClose = () => {
		cancelHoverChange();
		if (pinnedRef.current) return;
		hoverTimer.current = setTimeout(() => {
			hoverTimer.current = void 0;
			changeOpen(false);
		}, 120);
	};
	(0, useDismissOnOutsidePointer)(rootRef, open, changeOpen, panelRef);
	useEffect(() => {
		if (!open) return;
		const dismiss = (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			cancelHoverChange();
			pinnedRef.current = false;
			setOpen(false);
			if (panelRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
		};
		document.addEventListener("keydown", dismiss);
		return () => {
			document.removeEventListener("keydown", dismiss);
		};
	}, [open]);
	const compact = team !== void 0 && team.members.length === 1 && team.tasks.length === 0;
	return jsxs("div", {
		ref: rootRef,
		className: action.root,
		"data-team-action": true,
		onMouseLeave: scheduleHoverClose,
		children: [jsxs("button", {
			type: "button",
			ref: triggerRef,
			onMouseEnter: scheduleHoverOpen,
			className: action.trigger,
			"aria-label": t("trigger"),
			"aria-haspopup": "dialog",
			"aria-expanded": open,
			onClick: () => {
				cancelHoverChange();
				pinnedRef.current = true;
				if (!open) changeOpen(true);
				else panelRef.current?.focus();
			},
			children: [jsx(IconUsersOutlineRegular, { size: 14 }), jsx("span", {
				ref: triggerLabelRef,
				className: action.triggerLabel,
				children: t("trigger")
			})]
		}), open && createPortal(jsx("div", {
			ref: panelRef,
			className: compact ? `${action.panel} ${action.panelCompact}` : action.panel,
			style: position ?? {
				visibility: "hidden",
				left: 0,
				top: 0
			},
			role: "dialog",
			tabIndex: -1,
			"aria-label": t("trigger"),
			"data-team-panel": true,
			onMouseEnter: cancelHoverChange,
			onMouseLeave: scheduleHoverClose,
			children: jsxs("div", {
				className: action.body,
				children: [
					error !== null && jsxs("div", {
						className: action.error,
						role: "alert",
						children: [jsx(StateDot, { state: "error" }), error]
					}),
					team === void 0 && jsxs("div", {
						className: action.notice,
						role: "status",
						children: [jsx(StateDot, { state: opening || listing ? "ongoing" : "warning" }), t(opening || listing ? "loading" : "unavailable")]
					}),
					team !== void 0 && jsxs(Fragment, { children: [
						team.failure !== void 0 && jsxs("div", {
							className: action.error,
							role: "alert",
							children: [jsx(StateDot, { state: "error" }), t("failure", { message: team.failure })]
						}),
						jsxs("section", { children: [jsxs("h3", { children: [t("roster"), team.members.length > 1 && jsx("span", {
							className: action.count,
							children: team.members.length
						})] }), jsx("div", {
							className: action.roster,
							children: team.members.map((member) => jsx(TeamMemberRow, {
								member,
								memberCount: team.members.length,
								sessionId,
								useSessions,
								useSessionStatus,
								openTeammate,
								onError: setError,
								t
							}, member.id))
						})] }),
						jsx("section", { children: team.tasks.length === 0 ? jsx("p", {
							className: action.emptyNotice,
							children: t("empty")
						}) : jsxs(Fragment, { children: [jsxs("h3", { children: [t("tasks"), jsx("span", {
							className: action.count,
							children: team.tasks.length
						})] }), jsx("div", {
							className: action.tasks,
							children: team.tasks.map((task) => jsx(TaskCard, {
								task,
								t
							}, task.id))
						})] }) })
					] })
				]
			})
		}), document.body)]
	});
}
//#endregion

export { TeamAction }
