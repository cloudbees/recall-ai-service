// @ts-ignore — @types/rox-node is v5, runtime is v6
import Rox from 'rox-node';
import { featureFlags, configFlags, headerTheme } from './flags.ts';

const GLOBAL_KEY = '__fmRox__';
const CONFIG_KEY = '__fmConfigChanges__';

declare global {
  var __fmRox__: typeof Rox | undefined;
  var __fmConfigChanges__: ConfigChange[] | undefined;
}

export interface ConfigChange {
  /** When this process received the new configuration, epoch ms. */
  ts: number;
  /** SDK fetcher outcome, e.g. APPLIED_FROM_NETWORK. */
  status: string;
}

/** Kept short: this is for correlating a demo, not for auditing. */
const CONFIG_CHANGE_LIMIT = 20;

/**
 * Flag configuration changes this process has actually received.
 *
 * The handler below fires when the SDK applies new configuration, which is the
 * moment the server's answers change — typically about two seconds after someone
 * clicks in Feature Management. The SDK does not say WHICH flag changed, so this
 * is a "something changed at this instant" marker, not an audit trail. That is
 * exactly the right amount of information for the demonstration: the marker tells
 * you where to look, and Feature Management's audit history tells you what to
 * roll back.
 */
export function getConfigChanges(): ConfigChange[] {
  return globalThis[CONFIG_KEY] ?? [];
}

function recordConfigChange(status: string): void {
  const list = globalThis[CONFIG_KEY] ?? (globalThis[CONFIG_KEY] = []);
  list.unshift({ ts: Date.now(), status });
  if (list.length > CONFIG_CHANGE_LIMIT) list.length = CONFIG_CHANGE_LIMIT;
}

export async function initFM(): Promise<void> {
  const key = process.env.FM_KEY || process.env.NEXT_PUBLIC_FM_KEY;
  if (!key) {
    console.log('[FM] No FM_KEY set — flags will use defaults');
    return;
  }

  if (globalThis[GLOBAL_KEY]) {
    console.log('[FM] Already initialised — skipping');
    return;
  }

  Rox.register('recall', { ...featureFlags, ...configFlags, headerTheme });

  // Context-driven properties, for evaluating a flag AS a given identity rather
  // than as whatever the process last happened to set globally.
  //
  // A function property is handed the context passed to isEnabled(name, default,
  // context), so `isEnabled(f, false, { userId: 'user-42' })` resolves userId to
  // that value for that call alone. Point a percentage rollout's stickiness
  // property at `userId` and the bucket becomes md5(userId + seed) — fixed per
  // identity, so raising the percentage only ever adds users rather than
  // reshuffling them.
  //
  // This does NOT replace setFmCustomProperties below. That sets properties
  // globally on the SDK instance and is what the kill switch relies on; these
  // only produce a value when a context supplies one, and fall back to the
  // global value otherwise. Both mechanisms coexist.
  //
  // @ts-ignore — rox-node v6 accepts a function; @types/rox-node is v5
  Rox.setCustomStringProperty('userId', (ctx: { userId?: string } = {}) => ctx.userId ?? '');
  // @ts-ignore
  Rox.setCustomStringProperty('companySize', (ctx: { companySize?: string } = {}) => ctx.companySize ?? '');

  try {
    // configurationFetchedHandler is the only server-side notice that flag values
    // changed. Without it the SDK just quietly starts answering differently, and
    // there is nothing to line up against an error spike. `hasChanges` is false on
    // the polls that found nothing new, which is most of them — only the real
    // changes are recorded.
    await Rox.setup(key, {
      // The SDK pushes changes over SSE in about two seconds; this interval is only
      // the fallback poll for when that connection is not available. rox-node
      // defaults it to 60s. 30 matches the browser SDK in FMProvider.tsx, so a
      // server and a browser watching the same flag do not disagree for a minute.
      fetchIntervalInSec: 30,
      configurationFetchedHandler: (result: { fetcherStatus?: string; hasChanges?: boolean }) => {
        if (!result?.hasChanges) return;
        const status = result.fetcherStatus ?? 'UNKNOWN';
        recordConfigChange(status);
        console.log(`[FM] Configuration changed (${status})`);
      },
    });
    globalThis[GLOBAL_KEY] = Rox;
    console.log('[FM] SDK initialized successfully');
  } catch (err) {
    console.error('[FM] SDK setup failed:', err);
  }
}

export function getFmRox(): typeof Rox | undefined {
  return globalThis[GLOBAL_KEY];
}

function companySizeBucket(employeeCount: number): string {
  if (employeeCount >= 500) return 'enterprise';
  if (employeeCount >= 100) return 'mid-market';
  return 'small';
}

export function setFmCustomProperties(props: {
  companyName?: string;
  companyId?: string;
  employeeCount?: number;
  naicsCode?: string;
  state?: string;
  userId?: string;
  email?: string;
  supplyChainRole?: string;
  productCategory?: string;
  isLoggedIn?: boolean;
}): void {
  if (props.companyName) Rox.setCustomStringProperty('company', props.companyName);
  if (props.companyId) Rox.setCustomStringProperty('companyId', props.companyId);
  if (props.employeeCount != null) Rox.setCustomStringProperty('companySize', companySizeBucket(props.employeeCount));
  if (props.naicsCode) Rox.setCustomStringProperty('naicsCode', props.naicsCode);
  if (props.productCategory) Rox.setCustomStringProperty('productCategory', props.productCategory);
  if (props.state) Rox.setCustomStringProperty('state', props.state);
  if (props.userId) Rox.setCustomStringProperty('userId', props.userId);
  if (props.email) Rox.setCustomStringProperty('email', props.email);
  if (props.supplyChainRole) Rox.setCustomStringProperty('supplyChainRole', props.supplyChainRole);
  if (props.isLoggedIn != null) Rox.setCustomBooleanProperty('isLoggedIn', props.isLoggedIn);
}
