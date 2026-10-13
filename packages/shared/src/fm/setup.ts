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

  // Targeting properties, read from the context passed to each evaluation:
  //
  //   Rox.dynamicApi.isEnabled(flag, false, fmContext({ userId, email, ... }))
  //
  // Every property is a FUNCTION of that context, and nothing ever sets one to a
  // plain value. That is deliberate, and it fixes a real bug.
  //
  // A server SDK holds one set of custom properties for the whole process. The
  // previous version registered userId and companySize as functions here, then
  // setFmCustomProperties() re-registered them as plain values for whoever had
  // just loaded the matrix. Registering a property again REPLACES it, so from
  // that moment every evaluation in the process saw one user's userId:
  //
  //   - /admin/rollout bucketed all 200 sample identities into one bucket, so the
  //     grid went all-on or all-off as the percentage moved past it.
  //   - Two users loading the app at once could each be evaluated with the
  //     other's companySize, state or email — a targeting rule silently answering
  //     for the wrong person.
  //
  // With every property a function of the call's own context, each evaluation
  // sees only the identity it was given. An evaluation given no context sees
  // empty values, which is the honest answer for "no user".
  //
  // @ts-ignore — rox-node v6 accepts a function; @types/rox-node is v5
  for (const name of STRING_PROPERTIES) Rox.setCustomStringProperty(name, (ctx: FmContext = {}) => ctx[name] ?? '');
  // @ts-ignore
  Rox.setCustomBooleanProperty('isLoggedIn', (ctx: FmContext = {}) => ctx.isLoggedIn ?? false);

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

/** String targeting properties, as named in Feature Management target groups. */
const STRING_PROPERTIES = [
  'userId', 'email', 'company', 'companyId', 'companySize',
  'naicsCode', 'productCategory', 'state', 'supplyChainRole',
] as const;

export type FmContext = Partial<Record<(typeof STRING_PROPERTIES)[number], string>> & {
  isLoggedIn?: boolean;
};

/**
 * Build the evaluation context for one user. Pass the result as the third
 * argument to isEnabled() / value(); see the note in initFM() for why properties
 * are never set globally.
 */
export function fmContext(props: {
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
}): FmContext {
  const ctx: FmContext = {};
  if (props.companyName) ctx.company = props.companyName;
  if (props.companyId) ctx.companyId = props.companyId;
  if (props.employeeCount != null) ctx.companySize = companySizeBucket(props.employeeCount);
  if (props.naicsCode) ctx.naicsCode = props.naicsCode;
  if (props.productCategory) ctx.productCategory = props.productCategory;
  if (props.state) ctx.state = props.state;
  if (props.userId) ctx.userId = props.userId;
  if (props.email) ctx.email = props.email;
  if (props.supplyChainRole) ctx.supplyChainRole = props.supplyChainRole;
  if (props.isLoggedIn != null) ctx.isLoggedIn = props.isLoggedIn;
  return ctx;
}
