# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-19
- Context: Discovered by Agent while performing the v3.14.0 release task
- Category: Operations & Deployment
- Instructions:
  - 发布流程：功能开发在当前 fix/feat 分支完成 → git push 到 origin → 切到 master 并 pull → git merge --no-ff 分支到 master → git tag vX.Y.Z → git push origin master + tag → gh release create vX.Y.Z（标题带版本号与功能摘要，notes 列出主要变更）。
  - 远程仓库为 GitHub：https://github.com/iamsamyiok/agents-chat，push 偶发 HTTP 500 时直接重试即可。
  - 每个版本 commit message 需带上版本号（如 "(v3.14.0)"）。
