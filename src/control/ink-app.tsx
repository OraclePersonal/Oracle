import React, {
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import {
  Box,
  Text,
  render,
  useApp,
  useInput
} from "ink";
import type { RuntimeClient } from "../runtime/client.js";
import type { ApprovalRequest, ControlCenterSnapshot } from "./types.js";

const TABS = [
  "Overview",
  "Approvals",
  "Tasks",
  "Memory",
  "Audit",
  "Agents",
  "Scheduler"
] as const;

interface ControlAppProps {
  client: RuntimeClient;
  initial: ControlCenterSnapshot;
  actor: string;
  intervalMs: number;
}

type InputMode =
  | { type: "normal" }
  | { type: "filter"; value: string }
  | { type: "reject"; value: string }
  | { type: "confirm"; decision: "approve" | "reject"; note?: string };

export async function renderControlInk(options: ControlAppProps): Promise<void> {
  const instance = render(<ControlApp {...options} />);
  await instance.waitUntilExit();
}

export function ControlApp({
  client,
  initial,
  actor,
  intervalMs
}: ControlAppProps): React.ReactElement {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState(initial);
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState("");
  const [details, setDetails] = useState(false);
  const [mode, setMode] = useState<InputMode>({ type: "normal" });
  const [message, setMessage] = useState("Runtime connected");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await client.getControlSnapshot());
      setMessage("Updated");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [client]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, refresh]);

  const approvals = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return snapshot.approvals.items;
    return snapshot.approvals.items.filter((approval) =>
      [
        approval.id,
        approval.title,
        approval.requestedBy,
        approval.assignedTo,
        approval.risk
      ].some((value) => value.toLowerCase().includes(query))
    );
  }, [filter, snapshot.approvals.items]);

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, approvals.length - 1)));
  }, [approvals.length]);

  const selectedApproval = approvals[selected];
  const decide = useCallback(async (
    approval: ApprovalRequest,
    decision: "approve" | "reject",
    note?: string
  ) => {
    setBusy(true);
    try {
      const updated = await client.decideApproval(approval.id, {
        decision,
        decidedBy: actor,
        expectedVersion: approval.version,
        channel: "tui",
        note
      });
      setMessage(
        updated.status === "pending"
          ? `Vote recorded (${updated.approvalCount}/${updated.requiredApprovals})`
          : `Approval ${updated.status}`
      );
      setMode({ type: "normal" });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMode({ type: "normal" });
    } finally {
      setBusy(false);
    }
  }, [actor, client, refresh]);

  useInput((input, key) => {
    if (busy) return;
    if (mode.type === "filter" || mode.type === "reject") {
      if (key.escape) {
        setMode({ type: "normal" });
        return;
      }
      if (key.return) {
        if (mode.type === "filter") {
          setFilter(mode.value);
          setSelected(0);
          setMode({ type: "normal" });
        } else {
          setMode({ type: "confirm", decision: "reject", note: mode.value.trim() || "Rejected from Oracle Control." });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setMode({ ...mode, value: mode.value.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setMode({ ...mode, value: mode.value + input });
      }
      return;
    }

    if (mode.type === "confirm") {
      if ((input === "y" || key.return) && selectedApproval) {
        void decide(selectedApproval, mode.decision, mode.note);
      } else if (input === "n" || key.escape) {
        setMode({ type: "normal" });
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    } else if (key.leftArrow) {
      setTab((current) => (current + TABS.length - 1) % TABS.length);
      setSelected(0);
    } else if (key.rightArrow || key.tab) {
      setTab((current) => (current + 1) % TABS.length);
      setSelected(0);
    } else if (input === "j" || key.downArrow) {
      setSelected((current) => Math.min(current + 1, Math.max(0, approvals.length - 1)));
    } else if (input === "k" || key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
    } else if (key.return) {
      setDetails((current) => !current);
    } else if (input === "/") {
      setMode({ type: "filter", value: filter });
    } else if (input === "r") {
      void refresh();
    } else if (input === "a" && selectedApproval) {
      setMode({ type: "confirm", decision: "approve" });
    } else if (input === "x" && selectedApproval) {
      setMode({ type: "reject", value: "" });
    }
  });

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="blue" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">ORACLE CONTROL</Text>
        <Text color={snapshot.runtime.schedulerRunning ? "green" : "red"}>
          Runtime {snapshot.version} · pid {snapshot.runtime.pid}
        </Text>
      </Box>
      <Box paddingX={1} gap={2}>
        {TABS.map((name, index) => (
          <Text key={name} bold={index === tab} inverse={index === tab} color={index === tab ? "cyan" : "gray"}>
            {name}
          </Text>
        ))}
      </Box>
      <Box borderStyle="single" borderColor="blue" paddingX={1} minHeight={15} flexDirection="column">
        <TabContent
          tab={TABS[tab]}
          snapshot={snapshot}
          approvals={approvals}
          selected={selected}
          details={details}
        />
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text color="gray">←/→ tabs · j/k select · Enter details · / filter · a approve · x reject · r refresh · q quit</Text>
        <Text color={message.toLowerCase().includes("error") ? "red" : "cyan"}>{busy ? "Working…" : message}</Text>
      </Box>
      {filter && <Text color="yellow"> Filter: {filter}</Text>}
      {mode.type === "filter" && <Prompt label="Filter" value={mode.value} />}
      {mode.type === "reject" && <Prompt label="Reject reason" value={mode.value} />}
      {mode.type === "confirm" && (
        <Text color="yellow">
          {mode.decision === "approve" ? "Approve" : "Reject"} {selectedApproval?.id}? y/Enter confirm · n/Esc cancel
        </Text>
      )}
    </Box>
  );
}

function TabContent(props: {
  tab: typeof TABS[number];
  snapshot: ControlCenterSnapshot;
  approvals: ApprovalRequest[];
  selected: number;
  details: boolean;
}): React.ReactElement {
  const { tab, snapshot } = props;
  if (tab === "Overview") {
    return (
      <>
        <Text bold color="cyan">Human Control Plane</Text>
        <Text>Approvals: <Text color="yellow">{snapshot.approvals.pending}</Text> · High risk: <Text color="red">{snapshot.approvals.byRisk.high}</Text></Text>
        <Text>Tasks: <Text color="cyan">{snapshot.tasks.active}/{snapshot.tasks.total}</Text> active · Agents: <Text color="green">{snapshot.agents.active}/{snapshot.agents.total}</Text> active</Text>
        <Text>Memory: {snapshot.memory.project.total} project · Scheduler: {snapshot.schedules.length} jobs</Text>
        <Text>
          Audit: {snapshot.audit.integrity.valid
            ? <Text color="green">{snapshot.audit.integrity.verifiedEntries} verified</Text>
            : <Text color="red">broken at {snapshot.audit.integrity.brokenAt}</Text>}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>Pending approvals</Text>
          <ApprovalList {...props} limit={6} />
        </Box>
      </>
    );
  }
  if (tab === "Approvals") return <ApprovalList {...props} />;
  if (tab === "Tasks") {
    return (
      <>
        <Text bold>Task workflow</Text>
        <Text>
          pending {snapshot.tasks.byStatus.pending} · active {snapshot.tasks.byStatus.in_progress} · review {snapshot.tasks.byStatus.review} · blocked {snapshot.tasks.byStatus.blocked} · done {snapshot.tasks.byStatus.done}
        </Text>
        {snapshot.tasks.recent.slice(0, 10).map((task) => (
          <Text key={task.id} color={task.status === "blocked" ? "red" : task.status === "done" ? "green" : undefined}>
            {task.status.padEnd(11)} {truncate(task.title, 58)} · {task.assignee}
          </Text>
        ))}
      </>
    );
  }
  if (tab === "Memory") {
    return (
      <>
        <Text bold>Persistent memory</Text>
        <Text>Project {snapshot.memory.project.total} · Global {snapshot.memory.global.total}</Text>
        {snapshot.memory.project.recent.slice(0, 10).map((entry) => (
          <Text key={entry.id}><Text color="cyan">{entry.type.padEnd(10)}</Text> {truncate(entry.content, 76)}</Text>
        ))}
      </>
    );
  }
  if (tab === "Audit") {
    return (
      <>
        <Text bold>Audit chain</Text>
        <Text color={snapshot.audit.integrity.valid ? "green" : "red"}>
          {snapshot.audit.integrity.valid ? "VALID" : "INVALID"} · {snapshot.audit.integrity.verifiedEntries} verified · {snapshot.audit.integrity.legacyEntries} legacy
        </Text>
        {snapshot.audit.recent.slice(0, 10).map((entry, index) => (
          <Text key={`${entry.timestamp}-${index}`} color={entry.action === "policy_denied" ? "red" : undefined}>
            {String(entry.sequence ?? "—").padStart(4)} {entry.action.padEnd(14)} {truncate(entry.target, 60)}
          </Text>
        ))}
      </>
    );
  }
  if (tab === "Agents") {
    return (
      <>
        <Text bold>Agent presence</Text>
        {snapshot.agents.items.length
          ? snapshot.agents.items.slice(0, 12).map((agent) => (
              <Text key={agent.name} color={agent.active ? "green" : "gray"}>
                {agent.active ? "●" : "○"} {agent.name.padEnd(18)} {agent.role ?? "—"} · {shortAge(agent.lastSeen)}
              </Text>
            ))
          : <Text color="gray">No registered agents</Text>}
      </>
    );
  }
  return (
    <>
      <Text bold>Scheduler</Text>
      {snapshot.schedules.length
        ? snapshot.schedules.slice(0, 12).map((schedule) => (
            <Text key={schedule.id} color={schedule.status === "active" ? "green" : "gray"}>
              {schedule.status.padEnd(7)} {schedule.cron.padEnd(16)} {truncate(schedule.name, 48)}
            </Text>
          ))
        : <Text color="gray">No scheduled jobs</Text>}
    </>
  );
}

function ApprovalList(props: {
  approvals: ApprovalRequest[];
  selected: number;
  details: boolean;
  limit?: number;
}): React.ReactElement {
  const items = props.limit ? props.approvals.slice(0, props.limit) : props.approvals;
  if (!items.length) return <Text color="green">✓ No pending approvals</Text>;
  return (
    <>
      {items.slice(0, 12).map((approval, index) => (
        <Box key={approval.id} flexDirection="column">
          <Text inverse={index === props.selected}>
            <Text color={riskColor(approval)}>{approval.risk.toUpperCase().padEnd(6)}</Text>
            {" "}{truncate(approval.title, 54).padEnd(54)} {approval.approvalCount}/{approval.requiredApprovals}
          </Text>
          {props.details && index === props.selected && (
            <Box marginLeft={2} flexDirection="column">
              <Text color="gray">{approval.id} · v{approval.version}</Text>
              <Text>Reviewers: {approval.authorizedReviewers.join(", ")}</Text>
              {approval.description && <Text>{truncate(approval.description, 90)}</Text>}
              {approval.expiresAt && <Text color="yellow">Expires {new Date(approval.expiresAt).toLocaleString()}</Text>}
              {approval.payloadHash && <Text color="gray">Payload {approval.payloadHash}</Text>}
            </Box>
          )}
        </Box>
      ))}
    </>
  );
}

function Prompt({ label, value }: { label: string; value: string }): React.ReactElement {
  return <Text color="yellow"> {label}: {value}<Text inverse> </Text></Text>;
}

function riskColor(approval: ApprovalRequest): "red" | "yellow" | "green" {
  return approval.risk === "high" ? "red" : approval.risk === "medium" ? "yellow" : "green";
}

function truncate(value: unknown, width: number): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
}

function shortAge(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}
