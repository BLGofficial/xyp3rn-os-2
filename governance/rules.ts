export const LEGAL_RULES = [
  { id: 'license.required', description: 'Source must declare a license or a referenced permission grant.' },
  { id: 'license.commercial', description: 'Commercial use must not contradict noncommercial or personal-use restrictions.' },
  { id: 'attribution.required', description: 'A license requiring attribution must include attribution text.' },
  { id: 'consent.required', description: 'Generated likeness or cloned voice requires recorded consent.' },
] as const;
export type LegalInput = { license?: string; permissionRef?: string; commercial?: boolean; attributionRequired?: boolean; attribution?: string; usesLikeness?: boolean; consentRef?: string };
export const checkLegal = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Rights metadata must be an object');
  const input = value as LegalInput;
  for (const key of ['license','permissionRef','attribution','consentRef'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error(`Rights metadata ${key} must be a string`);
  }
  for (const key of ['commercial','attributionRequired','usesLikeness'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Rights metadata ${key} must be a boolean`);
  }
  const flags: { ruleId: string; reason: string }[] = [];
  if (!input.license?.trim() && !input.permissionRef?.trim()) flags.push({ ruleId: 'license.required', reason: 'No license or permission reference recorded' });
  if (input.commercial && /non.?commercial|personal.?use|\bnc\b/i.test(input.license ?? '')) flags.push({ ruleId: 'license.commercial', reason: 'License restricts commercial use' });
  if (input.attributionRequired && !input.attribution?.trim()) flags.push({ ruleId: 'attribution.required', reason: 'Required attribution is missing' });
  if (input.usesLikeness && !input.consentRef?.trim()) flags.push({ ruleId: 'consent.required', reason: 'Likeness or voice consent reference is missing' });
  return { checked: LEGAL_RULES.map(r => r.id), flags, status: flags.length ? 'flagged' : 'no-rule-violations', scope: 'Recorded metadata checks; no legal determination or rights clearance' };
};
