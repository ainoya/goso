import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { overview, type OverviewRow } from "@goso/core";
import {
  formatClock,
  formatDuration,
  loadSnapshot,
  providerIcon,
  severityColor,
  toPlainText,
  windowSubtitle,
  windowValue,
  type ProviderSnapshot,
  type Snapshot,
  type UsageWindow,
} from "./shared.ts";

/**
 * The top section answers "which agent is closest to a wall right now" without
 * scrolling: one row per agent, tightest window first.
 */
function OverviewItem({ row, now }: { row: OverviewRow; now: number }) {
  const { provider, window } = row;

  if (provider.status !== "ok") {
    return (
      <List.Item
        icon={providerIcon(provider)}
        title={provider.label}
        subtitle={provider.status === "error" ? "Error" : "Not available"}
        accessories={[{ text: "—" }]}
        keywords={[provider.id]}
      />
    );
  }

  const resetsAt = window?.resetsAt !== undefined && window.resetsAt > now ? window.resetsAt : undefined;

  const accessories: List.Item.Accessory[] = [];
  if (resetsAt !== undefined) {
    accessories.push({
      icon: Icon.Clock,
      text: formatClock(resetsAt),
      tooltip: `in ${formatDuration(resetsAt - now)}`,
    });
  }
  accessories.push({
    tag: { value: window ? windowValue(window) : "—", color: severityColor(window?.usedPercent) },
  });

  return (
    <List.Item
      icon={{ source: Icon.Gauge, tintColor: severityColor(window?.usedPercent) }}
      title={provider.label}
      subtitle={window?.label}
      accessories={accessories}
      keywords={[provider.id, window?.id ?? ""]}
    />
  );
}

function WindowItem({
  provider,
  window,
  now,
}: {
  provider: ProviderSnapshot;
  window: UsageWindow;
  now: number;
}) {
  const accessories: List.Item.Accessory[] = [
    {
      tag: { value: windowValue(window), color: severityColor(window.usedPercent) },
      tooltip: window.source === "reported" ? "Reported by the vendor" : "Derived from local activity",
    },
  ];

  return (
    <List.Item
      icon={{
        source: window.source === "reported" ? Icon.CheckCircle : Icon.Circle,
        tintColor: severityColor(window.usedPercent),
      }}
      title={window.label}
      subtitle={windowSubtitle(window, now)}
      accessories={accessories}
      keywords={[provider.id, provider.label, window.id]}
    />
  );
}

function ProviderSection({ provider, now }: { provider: ProviderSnapshot; now: number }) {
  if (provider.status !== "ok") {
    return (
      <List.Section title={provider.label}>
        <List.Item
          icon={providerIcon(provider)}
          title={provider.status === "error" ? "Error" : "Not available"}
          subtitle={provider.detail}
        />
      </List.Section>
    );
  }

  const subtitle = [provider.plan, provider.notes?.[0]].filter(Boolean).join("  ·  ");

  return (
    <List.Section title={provider.label} subtitle={subtitle}>
      {provider.windows.map((window) => (
        <WindowItem key={`${provider.id}-${window.id}`} provider={provider} window={window} now={now} />
      ))}
    </List.Section>
  );
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(loadSnapshot);
  const snapshot: Snapshot | undefined = data?.snapshot;
  const rows = snapshot ? overview(snapshot) : [];

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter agents and windows…"
      actions={
        <ActionPanel>
          <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
        </ActionPanel>
      }
    >
      {snapshot ? (
        <List.Section title="Overview" subtitle="can you use it right now?">
          {rows.map((row) => (
            <OverviewItem
              key={`overview-${row.provider.id}-${row.window?.id ?? "none"}`}
              row={row}
              now={snapshot.generatedAt}
            />
          ))}
        </List.Section>
      ) : null}

      {snapshot?.providers.map((provider) => (
        <ProviderSection key={provider.id} provider={provider} now={snapshot.generatedAt} />
      ))}

      {data?.fallbackReason ? (
        <List.Section title="Setup">
          <List.Item
            icon={{ source: Icon.Info, tintColor: Color.Orange }}
            title="Running without the goso CLI"
            subtitle={data.fallbackReason}
          />
        </List.Section>
      ) : null}

      {snapshot ? (
        <List.Section title="Snapshot" subtitle={data?.via === "cli" ? "via goso CLI" : "in-process"}>
          <List.Item
            icon={{ source: Icon.Clipboard, tintColor: Color.SecondaryText }}
            title="Copy as text"
            subtitle={formatClock(snapshot.generatedAt)}
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="Copy as Text" content={toPlainText(snapshot)} />
                <Action.CopyToClipboard title="Copy as JSON" content={JSON.stringify(snapshot, null, 2)} />
                <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}
    </List>
  );
}
