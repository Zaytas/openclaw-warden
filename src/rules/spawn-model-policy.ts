import type { Rule, RuleContext, BlockResult, SpawnModelPolicyConfig } from '../types.js';

type Tier = 'cheap' | 'mid' | 'heavy';

const TIER_ORDER: Record<Tier, number> = { cheap: 0, mid: 1, heavy: 2 };
const VALID_TIERS: Tier[] = ['cheap', 'mid', 'heavy'];

const ANNOTATION_RE = /\[model-tier:(cheap|mid|heavy)\]/i;

function isValidTier(value: unknown): value is Tier {
  return typeof value === 'string' && VALID_TIERS.includes(value as Tier);
}

function classifyTask(
  task: string,
  cheapPatterns: RegExp[],
  heavyPatterns: RegExp[],
  defaultTier: Tier,
): { tier: Tier; reason: string } {
  // Check for explicit tier annotation before pattern matching
  const annotationMatch = ANNOTATION_RE.exec(task);
  if (annotationMatch) {
    const tier = annotationMatch[1].toLowerCase() as Tier;
    return { tier, reason: 'explicit annotation' };
  }

  const matchesHeavy = heavyPatterns.some((re) => re.test(task));
  const matchesCheap = cheapPatterns.some((re) => re.test(task));

  if (matchesHeavy) return { tier: 'heavy', reason: 'matched heavy pattern' };
  if (matchesCheap) return { tier: 'cheap', reason: 'matched cheap pattern' };
  return { tier: defaultTier, reason: `default tier (${defaultTier})` };
}

function getModelTier(
  model: string | undefined,
  tiers: SpawnModelPolicyConfig['tiers'],
  missingModelTier: Tier,
  unknownModelTier: Tier,
  log: (msg: string) => void,
): Tier {
  if (!model) return missingModelTier;
  const lower = model.toLowerCase();

  // Match against tier patterns, preferring the longest (most specific) match
  let bestTier: Tier | undefined;
  let bestLength = -1;

  for (const tier of VALID_TIERS) {
    for (const pattern of tiers[tier]) {
      if (lower.includes(pattern.toLowerCase()) && pattern.length > bestLength) {
        bestTier = tier;
        bestLength = pattern.length;
      }
    }
  }

  if (bestTier) return bestTier;

  // Log warning for models not matching any configured tier
  log(`Warning: unknown model "${model}" — treating as ${unknownModelTier} tier`);
  return unknownModelTier;
}

/** Create a disabled stub rule (used when config validation fails). */
function createDisabledRule(): Rule {
  return {
    name: 'spawn-model-policy',
    onBeforeToolCall(): BlockResult {
      return undefined;
    },
  };
}

export function createSpawnModelPolicyRule(
  config: SpawnModelPolicyConfig,
  log: (msg: string) => void = console.log,
): Rule {
  // ── Config validation ──
  // Validate tier references
  if (!isValidTier(config.defaultTier)) {
    log(`ERROR: Invalid defaultTier "${config.defaultTier}" — rule DISABLED.`);
    return createDisabledRule();
  }
  if (!isValidTier(config.missingModelTier)) {
    log(`ERROR: Invalid missingModelTier "${config.missingModelTier}" — rule DISABLED.`);
    return createDisabledRule();
  }
  if (!isValidTier(config.unknownModelTier)) {
    log(`ERROR: Invalid unknownModelTier "${config.unknownModelTier}" — rule DISABLED.`);
    return createDisabledRule();
  }

  // Validate pattern arrays
  if (!Array.isArray(config.cheapPatterns) || !config.cheapPatterns.every((p) => typeof p === 'string')) {
    log('ERROR: cheapPatterns must be an array of strings — rule DISABLED.');
    return createDisabledRule();
  }
  if (!Array.isArray(config.heavyPatterns) || !config.heavyPatterns.every((p) => typeof p === 'string')) {
    log('ERROR: heavyPatterns must be an array of strings — rule DISABLED.');
    return createDisabledRule();
  }

  // Validate tier model pattern arrays
  for (const tier of VALID_TIERS) {
    if (!Array.isArray(config.tiers[tier])) {
      log(`ERROR: tiers.${tier} must be an array — rule DISABLED.`);
      return createDisabledRule();
    }
  }

  // Filter out empty string patterns (they'd match everything)
  const filteredCheapPatterns = config.cheapPatterns.filter((p) => {
    if (p === '') {
      log('Warning: empty string in cheapPatterns — skipping.');
      return false;
    }
    return true;
  });
  const filteredHeavyPatterns = config.heavyPatterns.filter((p) => {
    if (p === '') {
      log('Warning: empty string in heavyPatterns — skipping.');
      return false;
    }
    return true;
  });

  // Precompile regexes with validation
  let cheapRegexes: RegExp[];
  let heavyRegexes: RegExp[];
  try {
    cheapRegexes = filteredCheapPatterns.map((p) => new RegExp(p, 'i'));
    heavyRegexes = filteredHeavyPatterns.map((p) => new RegExp(p, 'i'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERROR: Invalid regex in config — rule DISABLED. ${msg}`);
    return createDisabledRule();
  }

  return {
    name: 'spawn-model-policy',

    onBeforeToolCall(ctx: RuleContext): BlockResult {
      if (!config.enabled) return undefined;
      if (ctx.toolName !== 'sessions_spawn') return undefined;

      // Safely extract params, handling non-string values
      const task = typeof ctx.toolParams?.task === 'string' ? ctx.toolParams.task : '';
      const model = typeof ctx.toolParams?.model === 'string' ? ctx.toolParams.model : undefined;

      const { tier, reason } = classifyTask(
        task,
        cheapRegexes,
        heavyRegexes,
        config.defaultTier,
      );

      // Log when annotation override is used
      if (reason === 'explicit annotation') {
        log(`Task annotation override: tier="${tier}" for model "${model ?? '(none)'}"`);
      }

      const modelTier = getModelTier(
        model,
        config.tiers,
        config.missingModelTier,
        config.unknownModelTier,
        log,
      );

      if (TIER_ORDER[modelTier] > TIER_ORDER[tier]) {
        const tierPatterns = config.tiers[tier];
        const allowedModels = tierPatterns.length > 0 ? tierPatterns.join(', ') : '';
        log(`Blocked: model tier "${modelTier}" exceeds task tier "${tier}" for model "${model ?? '(none)'}"`);
        return {
          block: true,
          blockReason:
            `🛡️ WARDEN: Model tier policy — this task was classified as "${tier}" complexity ` +
            `but the requested model is "${modelTier}" tier. ` +
            (allowedModels
              ? `Use a model matching a configured ${tier}-tier pattern (${allowedModels}). `
              : `Configure ${tier}-tier model patterns in spawnModelPolicy.tiers.${tier}. `) +
            `If this task truly requires a stronger model, add [model-tier:${modelTier}] to the task text. ` +
            `Classification reason: ${reason}.`,
        };
      }

      log(`Allowed: spawn with ${model ?? '(default)'} for ${tier} task`);
      return undefined;
    },
  };
}
