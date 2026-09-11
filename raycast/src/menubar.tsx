import { Icon, MenuBarExtra, open, Keyboard } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { formatReset, nextReset, rankWindows } from "@goso/core";
import { loadSnapshot, severityColor, windowSubtitle, windowValue } from "./shared.ts";

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(loadSnapshot);
  const snapshot = data?.snapshot;

  const ranked = snapshot ? rankWindows(snapshot) : [];
  const worst = ranked[0];
  const soonest = snapshot ? nextReset(snapshot) : undefined;

  // Menu-bar titles compete for space, so show only the tightest quota.
  const title = worst ? `${worst.usedPercent.toFixed(0)}%` : undefined;

  return (
    <MenuBarExtra
      icon={{ source: Icon.Gauge, tintColor: severityColor(worst?.usedPercent) }}
      title={title}
      tooltip={worst ? `${worst.provider.label} · ${worst.window.label}` : "goso — AI agent usage"}
      isLoading={isLoading}
    >
      {snapshot?.providers.map((provider) => (
        <MenuBarExtra.Section key={provider.id} title={provider.label}>
          {provider.status === "ok" ? (
            provider.windows.map((window) => (
              <MenuBarExtra.Item
                key={`${provider.id}-${window.id}`}
                icon={{ source: Icon.Circle, tintColor: severityColor(window.usedPercent) }}
                title={`${window.label} — ${windowValue(window)}`}
                subtitle={windowSubtitle(window, snapshot.generatedAt)}
              />
            ))
          ) : (
            <MenuBarExtra.Item title={provider.detail ?? provider.status} />
          )}
        </MenuBarExtra.Section>
      ))}

      <MenuBarExtra.Section>
        {data?.fallbackReason ? (
          <MenuBarExtra.Item
            icon={Icon.Info}
            title="Running without the goso CLI"
            subtitle={data.fallbackReason}
          />
        ) : null}
        {soonest?.window.resetsAt !== undefined && snapshot ? (
          <MenuBarExtra.Item
            icon={Icon.Clock}
            title={`Next reset: ${soonest.provider.label} ${soonest.window.label}`}
            subtitle={formatReset(soonest.window.resetsAt, snapshot.generatedAt)}
          />
        ) : null}
        <MenuBarExtra.Item
          icon={Icon.ArrowClockwise}
          title="Refresh"
          onAction={revalidate}
          shortcut={Keyboard.Shortcut.Common.Refresh}
        />
        <MenuBarExtra.Item
          icon={Icon.List}
          title="Open Full View"
          onAction={() => open("raycast://extensions/ainoya/goso/usage")}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
