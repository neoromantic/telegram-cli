# AI Integration Plan (Remaining Work)

> **Status: Partial** - remaining items below.

This plan tracks only the AI integration work that is not implemented yet. For
current behavior, see:
- [API Design](../api-design.md) (output contract + skill manifest)
- [CLI Commands](../cli-commands.md)
- [SQL Command](../sql.md)

## Remaining Work

### Claude Code Skill Descriptor
- Provide a Claude Code skill descriptor for auto-installation.
- Keep it aligned with the `tg skill manifest` format (see
  [Skill Manifest](../api-design.md#skill-manifest)).

### Skill Connectivity Verification
- Add connectivity verification for the skill tooling (currently planned).

### Message History Listing
- Add `tg messages list` (history per chat).

### Interactive Mode
- Add `tg interactive` to keep a single session open for batch commands.
