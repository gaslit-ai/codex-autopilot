---
name: skill-inventory
description: List repository skills and summarize their capabilities from SKILL.md frontmatter.
---

# Skill Inventory

Find `SKILL.md` files under `.agents/skills` with `rg --files --hidden -g SKILL.md .agents/skills`. Read each file's `name` and `description`; report malformed frontmatter and duplicate names rather than inferring capabilities.

Return a concise list sorted by skill name with source paths. When JSON is requested, use `{ "skills": [{ "name": "...", "description": "...", "source": "..." }] }`.

Inventory personal or plugin skills only when requested, using the locations or capabilities supplied by the current environment. Do not modify files.
