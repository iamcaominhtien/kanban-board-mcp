# Labelled controls the e2e run never acted on

"shown" means it was on a page at the end of some step but nothing clicked or typed in it.

## src/App.tsx (2)

- shown: `Blocked ticket` (src/App.tsx:1331)
- shown: `Move Anyway` (src/App.tsx:1348)

## src/components/AcceptanceCriteriaSection.tsx (2)

- never shown: `Save criterion` (src/components/AcceptanceCriteriaSection.tsx:195)
- shown: `Mark incomplete` (src/components/AcceptanceCriteriaSection.tsx:220, src/components/SubTasksSection.tsx:67)

## src/components/ActivitySection.tsx (1)

- never shown: `View comment` (src/components/ActivitySection.tsx:1427)

## src/components/Board.tsx (1)

- never shown: `Loading project` (src/components/Board.tsx:288)

## src/components/BranchGraph.tsx (5)

- shown: `Graph detail` (src/components/BranchGraph.tsx:172)
- shown: `Branches of this ticket` (src/components/BranchGraph.tsx:202)
- shown: `Commit graph` (src/components/BranchGraph.tsx:254)
- never shown: `Commit details` (src/components/BranchGraph.tsx:375)
- never shown: `Load older commits` (src/components/BranchGraph.tsx:195)

## src/components/Column.tsx (1)

- shown: `… active tickets` (src/components/Column.tsx:121, src/components/Column.tsx:133)

## src/components/CommentsSection.tsx (3)

- shown: `Undo` (src/components/CommentsSection.tsx:635, src/components/MarkdownEditor.tsx:957, src/components/ai/AiProfile.tsx:189, src/components/docs/AiChangedBar.tsx:119, src/components/sketch/SketchEditor.tsx:565)
- never shown: `Cancel send` (src/components/CommentsSection.tsx:894, src/components/CommentsSection.tsx:1035)
- never shown: `Retry` (src/components/CommentsSection.tsx:941, src/components/CommentsSection.tsx:1082, src/components/LoadingPill.tsx:49, src/components/ProjectSidebar.tsx:143, src/components/ai/RunPanel.tsx:410, src/components/ai/activity/design/designBlocks.tsx:2032, src/components/diagrams/DiagramEditor.tsx:521, src/components/diagrams/DiagramEditor.tsx:594, src/components/docs/comments/CommentBox.tsx:246, src/components/docs/comments/CommentsPanel.tsx:141, src/components/docs/comments/SendToAi.tsx:363, src/components/preview/TextReader.tsx:369)

## src/components/ConflictNotice.tsx (1)

- never shown: `View ticket` (src/components/ConflictNotice.tsx:31)

## src/components/CreateBranchModal.tsx (1)

- never shown: `Reset to template` (src/components/CreateBranchModal.tsx:297)

## src/components/DebugSpaceSection.tsx (8)

- shown: `Role` (src/components/DebugSpaceSection.tsx:298)
- shown: `Formatting` (src/components/DebugSpaceSection.tsx:313, src/components/docs/editor/EditorToolbar.tsx:140)
- shown: `Code` (src/components/DebugSpaceSection.tsx:337, src/components/MarkdownEditor.tsx:1136, src/components/ideas/IdeaDiscussion.tsx:350)
- shown: `Link` (src/components/DebugSpaceSection.tsx:359, src/components/MarkdownEditor.tsx:1187, src/components/docs/ai/DocsHealthView.tsx:199, src/components/ideas/IdeaDiscussion.tsx:353)
- never shown: `Linked branch` (src/components/DebugSpaceSection.tsx:396)
- never shown: `Linked test case` (src/components/DebugSpaceSection.tsx:410)
- shown: `Unpin entry` (src/components/DebugSpaceSection.tsx:754)
- never shown: `Confirm delete` (src/components/DebugSpaceSection.tsx:949, src/components/WorkspaceSection.tsx:621)

## src/components/FilterBar.tsx (1)

- shown: `Clear` (src/components/FilterBar.tsx:562, src/components/FilterBar.tsx:624, src/components/docs/HistoryDrawer.tsx:889, src/components/docs/SearchPalette.tsx:1439, src/components/notifications/NotificationRow.tsx:658, src/components/schedules/ScheduleEditor.tsx:490)

## src/components/LoadError.tsx (1)

- never shown: `Try again` (src/components/LoadError.tsx:35, src/components/McpIntegrations.tsx:325, src/components/McpIntegrations.tsx:448, src/components/MembersPanel.tsx:153, src/components/ai/AiDialogs.tsx:61, src/components/ai/AiMembersPage.tsx:523, src/components/ai/aiUi.tsx:423, src/components/ai/code/RepoCommands.tsx:344, src/components/ai/editor/useEditorAi.tsx:653, src/components/ai/editor/useEditorAi.tsx:724, src/components/assist/AnswerBlock.tsx:201, src/components/assist/AssistSettings.tsx:201, src/components/assist/DocsAi.tsx:131, src/components/canvas/CanvasEditor.tsx:2083, src/components/docs/ImportDialog.tsx:1086, src/components/docs/ai/AskPanel.tsx:292, src/components/ideas/IdeaAiExtras.tsx:503, src/components/ideas/IdeaAiPanel.tsx:509, src/components/ideas/IdeaAiPanel.tsx:522, src/components/ideas/IdeaPage.tsx:138, src/components/ideas/IdeaSpace.tsx:433, src/components/ideas/PromoteDialog.tsx:148, src/components/notifications/NotificationStates.tsx:48, src/components/preview/TextReader.tsx:386)

## src/components/MarkdownEditor.tsx (12)

- shown: `Redo` (src/components/MarkdownEditor.tsx:983, src/components/sketch/SketchEditor.tsx:576)
- shown: `Heading` (src/components/MarkdownEditor.tsx:1067)
- shown: `Insert doc reference` (src/components/MarkdownEditor.tsx:1163, src/components/comments/Composer.tsx:392)
- shown: `Attach File` (src/components/MarkdownEditor.tsx:1219)
- shown: `Canvas` (src/components/MarkdownEditor.tsx:1344, src/components/comments/Composer.tsx:420, src/components/docs/comments/CommentBox.tsx:308)
- shown: `Image` (src/components/MarkdownEditor.tsx:1364, src/components/canvas/EditorParts.tsx:142)
- shown: `Align left` (src/components/MarkdownEditor.tsx:1418)
- shown: `Align center` (src/components/MarkdownEditor.tsx:1444)
- shown: `Align right` (src/components/MarkdownEditor.tsx:1470)
- never shown: `Link text…` (src/components/MarkdownEditor.tsx:1540)
- never shown: `Remove image` (src/components/MarkdownEditor.tsx:1714)
- never shown: `Reset` (src/components/MarkdownEditor.tsx:1701, src/components/ai/tools/InstalledTab.tsx:170)

## src/components/McpFullControl.tsx (1)

- never shown: `Turn on full control over MCP` (src/components/McpFullControl.tsx:55)

## src/components/McpIntegrations.tsx (8)

- never shown: `/path/to/project` (src/components/McpIntegrations.tsx:385)
- never shown: `Project folder` (src/components/McpIntegrations.tsx:386)
- never shown: `Remove kanban from …` (src/components/McpIntegrations.tsx:497)
- never shown: `Check again` (src/components/McpIntegrations.tsx:336)
- never shown: `Browse…` (src/components/McpIntegrations.tsx:391)
- never shown: `Claude Code docs` (src/components/McpIntegrations.tsx:458)
- never shown: `Update` (src/components/McpIntegrations.tsx:536)
- shown: `Reinstall` (src/components/McpIntegrations.tsx:555)

## src/components/MembersPanel.tsx (1)

- never shown: `Open AI teams page →` (src/components/MembersPanel.tsx:196)

## src/components/PendingCloseConfirm.tsx (1)

- never shown: `Resume first` (src/components/PendingCloseConfirm.tsx:49)

## src/components/ProjectSidebar.tsx (1)

- shown: `Project navigation` (src/components/ProjectSidebar.tsx:116)

## src/components/RecycleBin.tsx (1)

- shown: `Empty bin` (src/components/RecycleBin.tsx:114)

## src/components/RelationsSection.tsx (7)

- never shown: `Blocks` (src/components/RelationsSection.tsx:325)
- never shown: `Blocked by` (src/components/RelationsSection.tsx:326)
- never shown: `Relates to` (src/components/RelationsSection.tsx:327)
- never shown: `Causes` (src/components/RelationsSection.tsx:328)
- never shown: `Caused by` (src/components/RelationsSection.tsx:329)
- never shown: `Duplicates` (src/components/RelationsSection.tsx:330)
- never shown: `Duplicated by` (src/components/RelationsSection.tsx:331)

## src/components/ReopenDropPopover.tsx (1)

- never shown: `More options` (src/components/ReopenDropPopover.tsx:134)

## src/components/ResumeDialog.tsx (1)

- never shown: `Resume …?` (src/components/ResumeDialog.tsx:114)

## src/components/SetPendingDialog.tsx (1)

- never shown: `Waiting on a ticket` (src/components/SetPendingDialog.tsx:347)

## src/components/Splash.tsx (2)

- never shown: `update` (src/components/Splash.tsx:276)
- never shown: `Update required` (src/components/Splash.tsx:276)

## src/components/StoryLanes.tsx (2)

- never shown: `__loose` (src/components/StoryLanes.tsx:167)
- shown: `…% done` (src/components/StoryLanes.tsx:228)

## src/components/StoryPage.tsx (2)

- shown: `Where you are` (src/components/StoryPage.tsx:128)
- never shown: `Sub-tickets` (src/components/StoryPage.tsx:293)

## src/components/SubTasksSection.tsx (1)

- never shown: `Save sub-task` (src/components/SubTasksSection.tsx:144)

## src/components/SubTicketsSection.tsx (4)

- shown: `Execution wave … of …, change` (src/components/SubTicketsSection.tsx:144)
- never shown: `Wave of …` (src/components/SubTicketsSection.tsx:157)
- never shown: `Earlier wave` (src/components/SubTicketsSection.tsx:190)
- never shown: `Later wave` (src/components/SubTicketsSection.tsx:212)

## src/components/TagPicker.tsx (1)

- never shown: `Tags` (src/components/TagPicker.tsx:179)

## src/components/TicketCard.tsx (3)

- shown: `Blocked` (src/components/TicketCard.tsx:238, src/components/icons/StatusMarks.tsx:67)
- shown: `Card options` (src/components/TicketCard.tsx:253)
- never shown: `Keep pending` (src/components/TicketCard.tsx:697, src/components/TicketModal.tsx:1675)

## src/components/TicketModal.tsx (23)

- never shown: `No estimate` (src/components/TicketModal.tsx:1038)
- never shown: `Exit fullscreen` (src/components/TicketModal.tsx:1483)
- shown: `Fullscreen` (src/components/TicketModal.tsx:1483)
- shown: `Ticket or AI activity` (src/components/TicketModal.tsx:1907)
- shown: `Reopen History` (src/components/TicketModal.tsx:2088)
- never shown: `Uploading …` (src/components/TicketModal.tsx:2558)
- shown: `Add attachment` (src/components/TicketModal.tsx:2574)
- never shown: `/absolute/path/to/local/git-repo` (src/components/TicketModal.tsx:3056)
- never shown: `Review by` (src/components/TicketModal.tsx:3188)
- shown: `Story` (src/components/TicketModal.tsx:1196, src/components/icons/TicketTypeIcons.tsx:214)
- shown: `Restore to Backlog` (src/components/TicketModal.tsx:1621)
- shown: `Ticket` (src/components/TicketModal.tsx:1908)
- shown: `Open in Flow` (src/components/TicketModal.tsx:1954, src/components/ai/activity/AiActivityDesign.tsx:47)
- never shown: `Reset to project` (src/components/TicketModal.tsx:3063)
- never shown: `Nobody` (src/components/TicketModal.tsx:3192)
- shown: `Medium` (src/components/TicketModal.tsx:3218)
- shown: `1 pt` (src/components/TicketModal.tsx:3299)
- shown: `2 pt` (src/components/TicketModal.tsx:3300)
- shown: `3 pt` (src/components/TicketModal.tsx:3301)
- shown: `5 pt` (src/components/TicketModal.tsx:3302)
- shown: `8 pt` (src/components/TicketModal.tsx:3303)
- shown: `13 pt` (src/components/TicketModal.tsx:3304)
- never shown: `Open Settings` (src/components/TicketModal.tsx:3707)

## src/components/UpdateNotice.tsx (4)

- never shown: `Download progress` (src/components/UpdateNotice.tsx:95)
- never shown: `Later` (src/components/UpdateNotice.tsx:120)
- never shown: `Skip this version` (src/components/UpdateNotice.tsx:123)
- never shown: `What's new` (src/components/UpdateNotice.tsx:129)

## src/components/WorkLogSection.tsx (2)

- never shown: `Your name...` (src/components/WorkLogSection.tsx:105)
- never shown: `Log Work` (src/components/WorkLogSection.tsx:138)

## src/components/WorkspaceSection.tsx (7)

- shown: `Copy path` (src/components/WorkspaceSection.tsx:271, src/components/ai/code/worktreeUi.tsx:143)
- never shown: `ticket ID, e.g. KAN-12` (src/components/WorkspaceSection.tsx:448)
- never shown: `Ticket to move the workspace to` (src/components/WorkspaceSection.tsx:449)
- never shown: `folder name` (src/components/WorkspaceSection.tsx:486)
- never shown: `New folder name` (src/components/WorkspaceSection.tsx:487)
- shown: `Download …` (src/components/WorkspaceSection.tsx:592)
- never shown: `Move` (src/components/WorkspaceSection.tsx:453)

## src/components/ai/AddTeamModal.tsx (3)

- shown: `Add AI team` (src/components/ai/AddTeamModal.tsx:82)
- shown: `Team pack` (src/components/ai/AddTeamModal.tsx:163)
- shown: `Default` (src/components/ai/AddTeamModal.tsx:152, src/components/ai/AiProfile.tsx:151, src/components/ai/AiProfile.tsx:338)

## src/components/ai/AiKillSwitch.tsx (1)

- shown: `AI paused…. …` (src/components/ai/AiKillSwitch.tsx:44)

## src/components/ai/AiMembersPage.tsx (2)

- never shown: `Add or remove people` (src/components/ai/AiMembersPage.tsx:159)
- shown: `AI settings` (src/components/ai/AiMembersPage.tsx:197)

## src/components/ai/AiProfile.tsx (8)

- shown: `… effort` (src/components/ai/AiProfile.tsx:147)
- shown: `Working folder` (src/components/ai/AiProfile.tsx:310)
- shown: `Model of the lead` (src/components/ai/AiProfile.tsx:320)
- shown: `Effort of the lead` (src/components/ai/AiProfile.tsx:335)
- shown: `Permission mode` (src/components/ai/AiProfile.tsx:349, src/components/ai/settings/RunningSettings.tsx:77)
- shown: `Same as lead` (src/components/ai/AiProfile.tsx:134)
- shown: `Add a role…` (src/components/ai/AiProfile.tsx:260)
- shown: `View on board` (src/components/ai/AiProfile.tsx:495)

## src/components/ai/AiSettingsSection.tsx (1)

- shown: `Manage AI teams` (src/components/ai/AiSettingsSection.tsx:58)

## src/components/ai/AssigneePicker.tsx (2)

- never shown: `Search people and teams…` (src/components/ai/AssigneePicker.tsx:133)
- never shown: `How to begin` (src/components/ai/AssigneePicker.tsx:408)

## src/components/ai/ComposerAi.tsx (1)

- never shown: `Pick which team to send to` (src/components/ai/ComposerAi.tsx:129)

## src/components/ai/DragConfirm.tsx (3)

- never shown: `Move … anyway` (src/components/ai/DragConfirm.tsx:42)
- never shown: `Keep it with the AI` (src/components/ai/DragConfirm.tsx:67)
- never shown: `Move and cancel run` (src/components/ai/DragConfirm.tsx:70)

## src/components/ai/MentionPill.tsx (2)

- never shown: `Assign here` (src/components/ai/MentionPill.tsx:214)
- never shown: `Profile` (src/components/ai/MentionPill.tsx:227)

## src/components/ai/QuestionCard.tsx (1)

- never shown: `type an answer…` (src/components/ai/QuestionCard.tsx:97)

## src/components/ai/RunPanel.tsx (2)

- shown: `Run options` (src/components/ai/RunPanel.tsx:97)
- shown: `Run again` (src/components/ai/RunPanel.tsx:452)

## src/components/ai/RunResources.tsx (1)

- never shown: `RAM of this run, last 5 minutes` (src/components/ai/RunResources.tsx:81)

## src/components/ai/RunView.tsx (2)

- never shown: `It reads this at its next step…` (src/components/ai/RunView.tsx:141)
- never shown: `It reads this when it takes its next turn…` (src/components/ai/RunView.tsx:141)

## src/components/ai/accounts/AccountBanner.tsx (1)

- never shown: `Choose another account` (src/components/ai/accounts/AccountBanner.tsx:68)

## src/components/ai/accounts/AccountPicker.tsx (4)

- shown: `AI account` (src/components/ai/accounts/AccountPicker.tsx:68)
- never shown: `Choose an account` (src/components/ai/accounts/AccountPicker.tsx:241)
- shown: `Add an account` (src/components/ai/accounts/AccountPicker.tsx:125)
- never shown: `Detect again` (src/components/ai/accounts/AccountPicker.tsx:165, src/components/ai/accounts/AccountsTab.tsx:210, src/components/ai/accounts/AddAccountModal.tsx:134)

## src/components/ai/accounts/AccountsTab.tsx (4)

- never shown: `Loading AI accounts` (src/components/ai/accounts/AccountsTab.tsx:112)
- shown: `AI accounts` (src/components/ai/accounts/AccountsTab.tsx:160)
- never shown: `Installation guide` (src/components/ai/accounts/AccountsTab.tsx:217, src/components/ai/accounts/AddAccountModal.tsx:137)
- shown: `Move to an account` (src/components/ai/accounts/AccountsTab.tsx:275)

## src/components/ai/accounts/AddAccountModal.tsx (2)

- never shown: `… is not installed` (src/components/ai/accounts/AddAccountModal.tsx:100)
- never shown: `Add an AI account` (src/components/ai/accounts/AddAccountModal.tsx:295)

## src/components/ai/accounts/RemoveAccountDialog.tsx (1)

- never shown: `Account for these teams` (src/components/ai/accounts/RemoveAccountDialog.tsx:93)

## src/components/ai/accounts/SignInWindow.tsx (4)

- never shown: `Stop signing in?` (src/components/ai/accounts/SignInWindow.tsx:445)
- never shown: `Cancel sign-in` (src/components/ai/accounts/SignInWindow.tsx:429)
- never shown: `Keep signing in` (src/components/ai/accounts/SignInWindow.tsx:461)
- never shown: `Stop` (src/components/ai/accounts/SignInWindow.tsx:465, src/components/ai/code/worktreeUi.tsx:147, src/components/ai/editor/useEditorAi.tsx:632, src/components/aiteam/ResourcesTab.tsx:237, src/components/assist/AnswerBlock.tsx:145, src/components/assist/AnswerBlock.tsx:155, src/components/assist/AnswerBlock.tsx:180, src/components/docs/ai/AskPanel.tsx:275, src/components/ideas/IdeaAiPanel.tsx:540, src/components/sketch/SketchAiPanel.tsx:451, src/components/sketch/SketchAiPanel.tsx:458)

## src/components/ai/accounts/SignedOutBanners.tsx (1)

- never shown: `Sign in again` (src/components/ai/accounts/SignedOutBanners.tsx:53)

## src/components/ai/activity/AiActivityDesign.tsx (2)

- never shown: `What to show` (src/components/ai/activity/AiActivityDesign.tsx:98)
- never shown: `One run` (src/components/ai/activity/AiActivityDesign.tsx:99)

## src/components/ai/activity/Resources.tsx (1)

- never shown: `RAM of the run over the last 5 minutes` (src/components/ai/activity/Resources.tsx:68)

## src/components/ai/activity/design/designBlocks.tsx (4)

- never shown: `RAM of each run over the last 5 minutes` (src/components/ai/activity/design/designBlocks.tsx:1841)
- never shown: `Undo run’s changes` (src/components/ai/activity/design/designBlocks.tsx:1028)
- never shown: `Raise limit` (src/components/ai/activity/design/designBlocks.tsx:1981)
- never shown: `Raise limit to 3 GB` (src/components/ai/activity/design/designBlocks.tsx:2035)

## src/components/ai/code/RepoCommands.tsx (3)

- never shown: `Loading` (src/components/ai/code/RepoCommands.tsx:191, src/components/ai/code/RepositoriesSection.tsx:84, src/components/ai/code/RepositoriesSection.tsx:244, src/components/ai/knowledge/KnowledgeBasePanel.tsx:38, src/components/ai/knowledge/KnowledgeSection.tsx:31, src/components/ai/tools/BoardSkillsCard.tsx:37, src/components/ai/tools/ByTeamTab.tsx:22, src/components/ai/tools/CatalogueTab.tsx:27, src/components/ai/tools/SkillsPluginsSection.tsx:59)
- never shown: `Where to look` (src/components/ai/code/RepoCommands.tsx:339)
- never shown: `e.g. this repo uses pnpm; the app is in ui/` (src/components/ai/code/RepoCommands.tsx:340)

## src/components/ai/code/RepoCommandsParts.tsx (9)

- shown: `… command` (src/components/ai/code/RepoCommandsParts.tsx:140)
- never shown: `prepare` (src/components/ai/code/RepoCommandsParts.tsx:143)
- shown: `npm ci && uv sync` (src/components/ai/code/RepoCommandsParts.tsx:143)
- never shown: `test` (src/components/ai/code/RepoCommandsParts.tsx:143)
- shown: `npm test` (src/components/ai/code/RepoCommandsParts.tsx:143)
- never shown: `lint` (src/components/ai/code/RepoCommandsParts.tsx:143)
- shown: `npm run lint` (src/components/ai/code/RepoCommandsParts.tsx:143)
- shown: `npm run build` (src/components/ai/code/RepoCommandsParts.tsx:143)
- shown: `Type one` (src/components/ai/code/RepoCommandsParts.tsx:212)

## src/components/ai/code/RepositoriesSection.tsx (1)

- shown: `Guessed from the repository` (src/components/ai/code/RepositoriesSection.tsx:186)

## src/components/ai/code/TicketHandover.tsx (3)

- never shown: `Hand the work over by` (src/components/ai/code/TicketHandover.tsx:114)
- never shown: `Pull request` (src/components/ai/code/TicketHandover.tsx:167)
- never shown: `Commit the code` (src/components/ai/code/TicketHandover.tsx:229)

## src/components/ai/code/worktreeUi.tsx (1)

- shown: `Open folder` (src/components/ai/code/worktreeUi.tsx:139)

## src/components/ai/editor/useEditorAi.tsx (17)

- never shown: `Translate into` (src/components/ai/editor/useEditorAi.tsx:1032)
- never shown: `Translate into… (English, Tiếng Việt, 日本語)` (src/components/ai/editor/useEditorAi.tsx:1033)
- never shown: `What should it write?` (src/components/ai/editor/useEditorAi.tsx:1052)
- never shown: `diagram` (src/components/ai/editor/useEditorAi.tsx:1053)
- never shown: `Describe the diagram…` (src/components/ai/editor/useEditorAi.tsx:1053)
- never shown: `doc` (src/components/ai/editor/useEditorAi.tsx:1053)
- never shown: `idea` (src/components/ai/editor/useEditorAi.tsx:1053)
- never shown: `Ask AI to write, with this page as context…` (src/components/ai/editor/useEditorAi.tsx:1053)
- never shown: `Ask AI to write, with this ticket as context…` (src/components/ai/editor/useEditorAi.tsx:1053)
- never shown: `AI on the selection` (src/components/ai/editor/useEditorAi.tsx:1202)
- never shown: `Show the draft` (src/components/ai/editor/useEditorAi.tsx:656)
- never shown: `Insert below` (src/components/ai/editor/useEditorAi.tsx:702, src/components/ai/editor/useEditorAi.tsx:943)
- never shown: `Continue` (src/components/ai/editor/useEditorAi.tsx:732, src/components/assist/AnswerBlock.tsx:261)
- never shown: `Open Members` (src/components/ai/editor/useEditorAi.tsx:798, src/components/docs/ai/AskPanel.tsx:255, src/components/docs/ai/AskPanel.tsx:287)
- never shown: `Open in the diagram editor` (src/components/ai/editor/useEditorAi.tsx:904)
- never shown: `T Selected text` (src/components/ai/editor/useEditorAi.tsx:1095)
- never shown: `What will be sent ⓘ` (src/components/ai/editor/useEditorAi.tsx:1105)

## src/components/ai/knowledge/KnowledgeBasePanel.tsx (4)

- never shown: `Search the knowledge base` (src/components/ai/knowledge/KnowledgeBasePanel.tsx:109)
- never shown: `Search as the AIs do: keywords` (src/components/ai/knowledge/KnowledgeBasePanel.tsx:110)
- never shown: `Search the shared store too` (src/components/ai/knowledge/KnowledgeBasePanel.tsx:69)
- never shown: `Add files` (src/components/ai/knowledge/KnowledgeBasePanel.tsx:79)

## src/components/ai/knowledge/MemoryPanel.tsx (3)

- never shown: `Keep it` (src/components/ai/knowledge/MemoryPanel.tsx:133, src/components/ai/knowledge/kbParts.tsx:190, src/components/settings/database/MoveCopyStep.tsx:97, src/components/settings/database/MoveStopped.tsx:361)
- never shown: `Edit and keep` (src/components/ai/knowledge/MemoryPanel.tsx:141)
- never shown: `No` (src/components/ai/knowledge/MemoryPanel.tsx:149, src/components/docs/ai/AskPanel.tsx:451, src/components/ideas/IdeaPage.tsx:737)

## src/components/ai/knowledge/TokenMeter.tsx (1)

- shown: `Share of the prompt budget` (src/components/ai/knowledge/TokenMeter.tsx:20)

## src/components/ai/knowledge/kbParts.tsx (9)

- never shown: `Text to add` (src/components/ai/knowledge/kbParts.tsx:285)
- never shown: `Paste text here` (src/components/ai/knowledge/kbParts.tsx:286)
- never shown: `Store` (src/components/ai/knowledge/kbParts.tsx:302)
- never shown: `Move to the shared store` (src/components/ai/knowledge/kbParts.tsx:156, src/components/ai/knowledge/kbParts.tsx:198)
- never shown: `Keep it here` (src/components/ai/knowledge/kbParts.tsx:167)
- never shown: `Move back to this project` (src/components/ai/knowledge/kbParts.tsx:208)
- never shown: `Choose a file` (src/components/ai/knowledge/kbParts.tsx:275, src/components/ideas/IdeaEvidenceTab.tsx:166)
- never shown: `This project` (src/components/ai/knowledge/kbParts.tsx:307)
- never shown: `The shared store` (src/components/ai/knowledge/kbParts.tsx:308)

## src/components/ai/packs/EnvBlock.tsx (4)

- never shown: `Folder …` (src/components/ai/packs/EnvBlock.tsx:40)
- shown: `New folder` (src/components/ai/packs/EnvBlock.tsx:149)
- never shown: `/opt/homebrew/bin` (src/components/ai/packs/EnvBlock.tsx:150)
- never shown: `The app’s own PATH` (src/components/ai/packs/EnvBlock.tsx:161)

## src/components/ai/packs/PackDialogs.tsx (9)

- never shown: `Start from` (src/components/ai/packs/PackDialogs.tsx:184)
- never shown: `Copy of` (src/components/ai/packs/PackDialogs.tsx:197)
- never shown: `Name` (src/components/ai/packs/PackDialogs.tsx:223, src/components/ai/packs/PackEditor.tsx:261)
- never shown: `Release manager` (src/components/ai/packs/PackDialogs.tsx:226)
- never shown: `Key` (src/components/ai/packs/PackDialogs.tsx:236)
- never shown: `release_manager` (src/components/ai/packs/PackDialogs.tsx:238)
- never shown: `Add the role` (src/components/ai/packs/PackDialogs.tsx:170)
- never shown: `A copy of` (src/components/ai/packs/PackDialogs.tsx:185)
- never shown: `Blank` (src/components/ai/packs/PackDialogs.tsx:208)

## src/components/ai/packs/PackEditor.tsx (13)

- never shown: `Model` (src/components/ai/packs/PackEditor.tsx:114)
- never shown: `Model id` (src/components/ai/packs/PackEditor.tsx:146)
- never shown: `A full model id` (src/components/ai/packs/PackEditor.tsx:148)
- never shown: `Glyph` (src/components/ai/packs/PackEditor.tsx:273)
- never shown: `Hands in` (src/components/ai/packs/PackEditor.tsx:309)
- never shown: `Effort` (src/components/ai/packs/PackEditor.tsx:350, src/components/ai/packs/PackEditor.tsx:367)
- never shown: `Model for a second try` (src/components/ai/packs/PackEditor.tsx:382)
- never shown: `Writes` (src/components/ai/packs/PackEditor.tsx:401)
- never shown: `At once` (src/components/ai/packs/PackEditor.tsx:452)
- never shown: `Other…` (src/components/ai/packs/PackEditor.tsx:130)
- shown: `None` (src/components/ai/packs/PackEditor.tsx:386, src/components/docs/ai/DocsAiSettings.tsx:100)
- never shown: `Reset to ready-made` (src/components/ai/packs/PackEditor.tsx:495, src/components/ai/packs/PackEditor.tsx:501)
- never shown: `Remove this role` (src/components/ai/packs/PackEditor.tsx:508)

## src/components/ai/packs/PackList.tsx (2)

- shown: `More for …` (src/components/ai/packs/PackList.tsx:66)
- shown: `Actions` (src/components/ai/packs/PackList.tsx:114)

## src/components/ai/power/KeepAwakeChip.tsx (1)

- never shown: `Keep awake` (src/components/ai/power/KeepAwakeChip.tsx:104)

## src/components/ai/run/RunTree.tsx (4)

- never shown: `Hide its steps` (src/components/ai/run/RunTree.tsx:105)
- shown: `Show its steps` (src/components/ai/run/RunTree.tsx:105)
- never shown: `Hide output` (src/components/ai/run/RunTree.tsx:105)
- shown: `Show output` (src/components/ai/run/RunTree.tsx:105)

## src/components/ai/settings/RunningSettings.tsx (2)

- never shown: `No cap` (src/components/ai/settings/RunningSettings.tsx:271)
- never shown: `No budget` (src/components/ai/settings/RunningSettings.tsx:290)

## src/components/ai/tools/AddFromSource.tsx (2)

- never shown: `Version` (src/components/ai/tools/AddFromSource.tsx:146)
- never shown: `Latest` (src/components/ai/tools/AddFromSource.tsx:148)

## src/components/ai/tools/BoardSkillsCard.tsx (1)

- never shown: `Follow the default` (src/components/ai/tools/BoardSkillsCard.tsx:105)

## src/components/ai/tools/CatalogueTab.tsx (1)

- never shown: `Add…` (src/components/ai/tools/CatalogueTab.tsx:74)

## src/components/ai/tools/InstalledTab.tsx (10)

- never shown: `Working` (src/components/ai/tools/InstalledTab.tsx:222)
- shown: `Search skills and plugins…` (src/components/ai/tools/InstalledTab.tsx:306)
- shown: `Search installed` (src/components/ai/tools/InstalledTab.tsx:307)
- shown: `Filter` (src/components/ai/tools/InstalledTab.tsx:313)
- never shown: `See what changed` (src/components/ai/tools/InstalledTab.tsx:120)
- shown: `Open` (src/components/ai/tools/InstalledTab.tsx:129, src/components/assist/TicketChat.tsx:27, src/components/ideas/Triage.tsx:324, src/components/notifications/DayCard.tsx:73, src/components/notifications/NotificationRow.tsx:337, src/components/settings/database/DatabaseCard.tsx:301)
- never shown: `Unpin` (src/components/ai/tools/InstalledTab.tsx:133, src/components/ideas/IdeaDiscussion.tsx:446)
- shown: `Check for update` (src/components/ai/tools/InstalledTab.tsx:142, src/components/ai/tools/InstalledTab.tsx:174)
- shown: `Reload` (src/components/ai/tools/InstalledTab.tsx:166, src/components/docs/ConflictBanner.tsx:99, src/components/preview/HtmlReader.tsx:56)
- never shown: `Roll back` (src/components/ai/tools/InstalledTab.tsx:190)

## src/components/ai/tools/SkillsPluginsSection.tsx (4)

- never shown: `('installed'); const [pick, setPick] = useState` (src/components/ai/tools/SkillsPluginsSection.tsx:16)
- shown: `Reload all` (src/components/ai/tools/SkillsPluginsSection.tsx:89)
- never shown: `Reset all` (src/components/ai/tools/SkillsPluginsSection.tsx:100)
- shown: `Reset all to the catalogue` (src/components/ai/tools/SkillsPluginsSection.tsx:108)

## src/components/aiteam/FlowMap.tsx (2)

- never shown: `Map of the teams, you and the tickets` (src/components/aiteam/FlowMap.tsx:284)
- never shown: `Widen the range` (src/components/aiteam/FlowMap.tsx:366, src/components/aiteam/SteppedInTab.tsx:495)

## src/components/aiteam/FlowScopeBar.tsx (7)

- shown: `What Flow looks at` (src/components/aiteam/FlowScopeBar.tsx:167)
- never shown: `Go to a team, Story or ticket` (src/components/aiteam/FlowScopeBar.tsx:207, src/components/aiteam/FlowScopeBar.tsx:191)
- never shown: `code or words` (src/components/aiteam/FlowScopeBar.tsx:214)
- never shown: `Search teams, Stories and tickets` (src/components/aiteam/FlowScopeBar.tsx:215)
- shown: `View` (src/components/aiteam/FlowScopeBar.tsx:290, src/components/ideas/IdeaSpace.tsx:312, src/components/schedules/SchedulesTab.tsx:438)
- shown: `Copy link` (src/components/aiteam/FlowScopeBar.tsx:287, src/components/diagrams/DiagramEmbed.tsx:188, src/components/docs/DocPeekPanel.tsx:191, src/components/preview/PreviewViewer.tsx:507)
- shown: `Map` (src/components/aiteam/FlowScopeBar.tsx:291, src/components/canvas/CanvasEditor.tsx:2179)

## src/components/aiteam/FlowTab.tsx (2)

- never shown: `Drawing the map` (src/components/aiteam/FlowTab.tsx:192)
- never shown: `Add an AI team` (src/components/aiteam/FlowTab.tsx:153)

## src/components/aiteam/HealthTab.tsx (2)

- never shown: `Open a run` (src/components/aiteam/HealthTab.tsx:109)
- never shown: `Widen to 30 days` (src/components/aiteam/HealthTab.tsx:296)

## src/components/aiteam/HistoryTab.tsx (1)

- shown: `Show runs` (src/components/aiteam/HistoryTab.tsx:35)

## src/components/aiteam/NowTab.tsx (1)

- never shown: `See the roles →` (src/components/aiteam/NowTab.tsx:124)

## src/components/aiteam/RecentSpend.tsx (1)

- never shown: `…: … % of the cap` (src/components/aiteam/RecentSpend.tsx:99)

## src/components/aiteam/ResourcesTab.tsx (6)

- shown: `RAM of each run, last 5 minutes` (src/components/aiteam/ResourcesTab.tsx:123)
- never shown: `stop` (src/components/aiteam/ResourcesTab.tsx:254)
- never shown: `Confirm stop` (src/components/aiteam/ResourcesTab.tsx:254)
- never shown: `Confirm restart` (src/components/aiteam/ResourcesTab.tsx:254)
- never shown: `Restart` (src/components/aiteam/ResourcesTab.tsx:227)
- shown: `All AI limits in Settings →` (src/components/aiteam/ResourcesTab.tsx:524)

## src/components/aiteam/RunDetail.tsx (1)

- shown: `← All runs` (src/components/aiteam/RunDetail.tsx:22)

## src/components/aiteam/SteppedInTab.tsx (5)

- never shown: `The lesson` (src/components/aiteam/SteppedInTab.tsx:134)
- shown: `Mark this touch (…)` (src/components/aiteam/SteppedInTab.tsx:217)
- never shown: `Make a lesson` (src/components/aiteam/SteppedInTab.tsx:252)
- never shown: `Propose to Memory` (src/components/aiteam/SteppedInTab.tsx:274)
- shown: `Export CSV` (src/components/aiteam/SteppedInTab.tsx:471)

## src/components/aiteam/TeamPage.tsx (2)

- never shown: `Roles, limits and account: open on the Members page →` (src/components/aiteam/TeamPage.tsx:102)
- never shown: `← All teams` (src/components/aiteam/TeamPage.tsx:167)

## src/components/aiteam/TimelineGroups.tsx (1)

- never shown: `…: … the roles` (src/components/aiteam/TimelineGroups.tsx:96)

## src/components/aiteam/TimelineStrip.tsx (2)

- shown: `The range at a glance: drag the box to move it, drag an edge to zoom` (src/components/aiteam/TimelineStrip.tsx:103)
- never shown: `Reset zoom` (src/components/aiteam/TimelineStrip.tsx:159, src/components/diagrams/DiagramViewer.tsx:112)

## src/components/aiteam/TimelineTab.tsx (14)

- never shown: `Custom range` (src/components/aiteam/TimelineTab.tsx:119)
- shown: `Detail` (src/components/aiteam/TimelineTab.tsx:514)
- shown: `Time` (src/components/aiteam/TimelineTab.tsx:522, src/components/assist/BoardHealth.tsx:195)
- shown: `Timeline diagram` (src/components/aiteam/TimelineTab.tsx:665)
- shown: `Answer` (src/components/aiteam/TimelineTab.tsx:1508)
- never shown: `Show this range` (src/components/aiteam/TimelineTab.tsx:145)
- shown: `Compact` (src/components/aiteam/TimelineTab.tsx:515)
- shown: `Detailed` (src/components/aiteam/TimelineTab.tsx:518)
- shown: `Compact time` (src/components/aiteam/TimelineTab.tsx:523)
- shown: `Real time` (src/components/aiteam/TimelineTab.tsx:526)
- shown: `Widen to 7 days` (src/components/aiteam/TimelineTab.tsx:815)
- never shown: `Open the map` (src/components/aiteam/TimelineTab.tsx:819)
- never shown: `Open the run` (src/components/aiteam/TimelineTab.tsx:1535)
- never shown: `Open the ticket` (src/components/aiteam/TimelineTab.tsx:1540)

## src/components/aiteam/teamUi.tsx (1)

- never shown: `The conversation is …% full` (src/components/aiteam/teamUi.tsx:162)

## src/components/assist/AnswerBlock.tsx (8)

- shown: `Copy answer` (src/components/assist/AnswerBlock.tsx:437)
- shown: `Regenerate` (src/components/assist/AnswerBlock.tsx:443)
- shown: `Not helpful` (src/components/assist/AnswerBlock.tsx:459)
- never shown: `Keep waiting` (src/components/assist/AnswerBlock.tsx:142)
- never shown: `Send now` (src/components/assist/AnswerBlock.tsx:232)
- never shown: `Settings → AI` (src/components/assist/AnswerBlock.tsx:360)
- never shown: `See what was sent` (src/components/assist/AnswerBlock.tsx:376)
- never shown: `Send all` (src/components/assist/AnswerBlock.tsx:379)

## src/components/assist/AssistDock.tsx (11)

- never shown: `Chat history` (src/components/assist/AssistDock.tsx:94, src/components/assist/AssistDock.tsx:355)
- never shown: `Search chats…` (src/components/assist/AssistDock.tsx:107)
- never shown: `Search chats` (src/components/assist/AssistDock.tsx:110)
- never shown: `Board AI` (src/components/assist/AssistDock.tsx:330)
- never shown: `Scope` (src/components/assist/AssistDock.tsx:414, src/components/assist/AssistDock.tsx:518)
- never shown: `Remove doc` (src/components/assist/AssistDock.tsx:475)
- never shown: `What the Board AI may read` (src/components/assist/AssistDock.tsx:507)
- never shown: `Ask about the project instead` (src/components/assist/AssistDock.tsx:403)
- never shown: `Open Settings → AI` (src/components/assist/AssistDock.tsx:558)
- never shown: `Ask for a first ticket` (src/components/assist/AssistDock.tsx:588)
- never shown: `Skip` (src/components/assist/AssistDock.tsx:595, src/components/assist/DocsAi.tsx:179)

## src/components/assist/AssistSettings.tsx (2)

- shown: `Tone` (src/components/assist/AssistSettings.tsx:80)
- shown: `Open AI Team →` (src/components/assist/AssistSettings.tsx:186)

## src/components/assist/BoardHealth.tsx (4)

- shown: `Snooze` (src/components/assist/BoardHealth.tsx:54, src/components/notifications/NotificationRow.tsx:416)
- never shown: `Schedule and noise controls` (src/components/assist/BoardHealth.tsx:367)
- shown: `Open Board health` (src/components/assist/BoardHealth.tsx:505)
- shown: `Snooze all` (src/components/assist/BoardHealth.tsx:515)

## src/components/assist/ContextMeter.tsx (1)

- never shown: `The conversation is … full` (src/components/assist/ContextMeter.tsx:32)

## src/components/assist/DocsAi.tsx (6)

- never shown: `KAN-154` (src/components/assist/DocsAi.tsx:477)
- never shown: `Accept all` (src/components/assist/DocsAi.tsx:156)
- never shown: `Accept` (src/components/assist/DocsAi.tsx:176, src/components/docs/ai/CheckThisPage.tsx:112)
- never shown: `Summarise this page` (src/components/assist/DocsAi.tsx:408)
- never shown: `Draft a section from a ticket…` (src/components/assist/DocsAi.tsx:412)
- never shown: `Suggest [[ ]] links` (src/components/assist/DocsAi.tsx:415)

## src/components/assist/ScopedChat.tsx (4)

- never shown: `Chat menu` (src/components/assist/ScopedChat.tsx:486)
- never shown: `Commands` (src/components/assist/ScopedChat.tsx:693)
- never shown: `Open AI Team` (src/components/assist/ScopedChat.tsx:141, src/components/assist/ScopedChat.tsx:163)
- never shown: `Chat` (src/components/assist/ScopedChat.tsx:459)

## src/components/assist/TicketAi.tsx (1)

- shown: `More AI helpers` (src/components/assist/TicketAi.tsx:91)

## src/components/assist/quoteReplies.tsx (3)

- never shown: `Your reply to this part…` (src/components/assist/quoteReplies.tsx:222)
- never shown: `Reply to passage …` (src/components/assist/quoteReplies.tsx:223)
- never shown: `Remove passage …` (src/components/assist/quoteReplies.tsx:236)

## src/components/canvas/CanvasEditor.tsx (22)

- shown: `Canvas …` (src/components/canvas/CanvasEditor.tsx:1032)
- shown: `Canvas name` (src/components/canvas/CanvasEditor.tsx:1046)
- shown: `Keys` (src/components/canvas/CanvasEditor.tsx:1262, src/components/canvas/EditorParts.tsx:339)
- shown: `Pages` (src/components/canvas/CanvasEditor.tsx:1288, src/components/docs/MoveToDialog.tsx:572, src/components/docs/MoveToDialog.tsx:638, src/components/preview/PdfReader.tsx:320)
- shown: `Add a page tab` (src/components/canvas/CanvasEditor.tsx:1329)
- never shown: `Delete this page tab` (src/components/canvas/CanvasEditor.tsx:1346)
- never shown: `Label text` (src/components/canvas/CanvasEditor.tsx:1591)
- never shown: `Board name` (src/components/canvas/CanvasEditor.tsx:1653)
- shown: `Board menu` (src/components/canvas/CanvasEditor.tsx:1812)
- shown: `Note colour …` (src/components/canvas/CanvasEditor.tsx:1962)
- shown: `Zoom out` (src/components/canvas/CanvasEditor.tsx:2154, src/components/diagrams/DiagramViewer.tsx:93, src/components/preview/ImageReader.tsx:320, src/components/preview/PdfReader.tsx:283, src/components/sketch/SketchEditor.tsx:588)
- shown: `Tools` (src/components/canvas/CanvasEditor.tsx:2188, src/components/sketch/SketchEditor.tsx:744)
- never shown: `Is the button label long enough for Vietnamese?` (src/components/canvas/CanvasEditor.tsx:2284)
- shown: `Close panel` (src/components/canvas/CanvasEditor.tsx:2363, src/components/docs/DocPeekPanel.tsx:198)
- shown: `Save a copy` (src/components/canvas/CanvasEditor.tsx:1245, src/components/sketch/SketchEditor.tsx:642, src/components/sketch/SketchEditor.tsx:699)
- shown: `Share` (src/components/canvas/CanvasEditor.tsx:1250)
- never shown: `Trying it: clicks go to the page. Stop` (src/components/canvas/CanvasEditor.tsx:1718)
- never shown: `Save as copy` (src/components/canvas/CanvasEditor.tsx:2053, src/components/diagrams/DiagramEditor.tsx:530)
- never shown: `Load theirs` (src/components/canvas/CanvasEditor.tsx:2060)
- never shown: `Replace theirs` (src/components/canvas/CanvasEditor.tsx:2068, src/components/sketch/SketchEditor.tsx:708)
- shown: `Fit` (src/components/canvas/CanvasEditor.tsx:2173, src/components/preview/ImageReader.tsx:334, src/components/preview/PdfReader.tsx:290)
- shown: `Boards` (src/components/canvas/CanvasEditor.tsx:2339)

## src/components/canvas/CanvasEmbed.tsx (1)

- shown: `Canvas actions` (src/components/canvas/CanvasEmbed.tsx:180)

## src/components/canvas/CanvasViewer.tsx (8)

- never shown: `Previous board` (src/components/canvas/CanvasViewer.tsx:196)
- never shown: `Next board` (src/components/canvas/CanvasViewer.tsx:205)
- never shown: `Page width` (src/components/canvas/CanvasViewer.tsx:311, src/components/preview/HtmlReader.tsx:49)
- shown: `Present` (src/components/canvas/CanvasViewer.tsx:450)
- never shown: `Previous` (src/components/canvas/CanvasViewer.tsx:452, src/components/preview/OfficeReader.tsx:271, src/components/preview/PreviewViewer.tsx:417)
- never shown: `Open canvas` (src/components/canvas/CanvasViewer.tsx:365)
- never shown: `Try it` (src/components/canvas/CanvasViewer.tsx:462)
- never shown: `Exit` (src/components/canvas/CanvasViewer.tsx:500)

## src/components/canvas/CommentsPanel.tsx (4)

- never shown: `Filter comments` (src/components/canvas/CommentsPanel.tsx:149)
- never shown: `Comment on “…”… Type @ to mention a person or a team` (src/components/canvas/CommentsPanel.tsx:168)
- never shown: `Delete thread` (src/components/canvas/CommentsPanel.tsx:241)
- shown: `Reply…` (src/components/canvas/CommentsPanel.tsx:256, src/components/docs/comments/ThreadCard.tsx:676)

## src/components/canvas/EditorParts.tsx (7)

- never shown: `Find a board…` (src/components/canvas/EditorParts.tsx:242)
- never shown: `Find a board` (src/components/canvas/EditorParts.tsx:245)
- never shown: `Fit height to content` (src/components/canvas/EditorParts.tsx:104)
- never shown: `Custom…` (src/components/canvas/EditorParts.tsx:109)
- never shown: `Files` (src/components/canvas/EditorParts.tsx:138)
- never shown: `SVG` (src/components/canvas/EditorParts.tsx:153)
- never shown: `GIF` (src/components/canvas/EditorParts.tsx:166)

## src/components/canvas/HistoryPanel.tsx (4)

- never shown: `Compare versions` (src/components/canvas/HistoryPanel.tsx:239)
- never shown: `Restore this version` (src/components/canvas/HistoryPanel.tsx:149)
- never shown: `Name…` (src/components/canvas/HistoryPanel.tsx:160)
- never shown: `Compare with the one before` (src/components/canvas/HistoryPanel.tsx:165)

## src/components/canvas/MoveToDocsDialog.tsx (2)

- never shown: `Move to Docs` (src/components/canvas/MoveToDocsDialog.tsx:58)
- shown: `Top level` (src/components/canvas/MoveToDocsDialog.tsx:71)

## src/components/canvas/NewCanvasDialog.tsx (3)

- never shown: `New canvas` (src/components/canvas/NewCanvasDialog.tsx:47)
- never shown: `Start with` (src/components/canvas/NewCanvasDialog.tsx:72)
- never shown: `Choose files` (src/components/canvas/NewCanvasDialog.tsx:103)

## src/components/canvas/SourceEditor.tsx (8)

- never shown: `Someone else is editing` (src/components/canvas/SourceEditor.tsx:274)
- never shown: `Source of …` (src/components/canvas/SourceEditor.tsx:469)
- never shown: `Preview width` (src/components/canvas/SourceEditor.tsx:487)
- never shown: `OK` (src/components/canvas/SourceEditor.tsx:296)
- never shown: `Keep editing` (src/components/canvas/SourceEditor.tsx:367, src/components/diagrams/DiagramEditor.tsx:675, src/components/docs/DiscardDialog.tsx:101, src/components/sketch/SketchEditor.tsx:891)
- never shown: `Back to editor` (src/components/canvas/SourceEditor.tsx:391, src/components/diagrams/DiagramEditor.tsx:653)
- never shown: `Save as new board` (src/components/canvas/SourceEditor.tsx:395, src/components/canvas/SourceEditor.tsx:415)
- never shown: `+ Add file` (src/components/canvas/SourceEditor.tsx:452)

## src/components/canvas/useCanvasBlocks.tsx (4)

- never shown: `Embed settings` (src/components/canvas/useCanvasBlocks.tsx:128)
- never shown: `Whole canvas` (src/components/canvas/useCanvasBlocks.tsx:135)
- never shown: `One board` (src/components/canvas/useCanvasBlocks.tsx:144)
- never shown: `Link only` (src/components/canvas/useCanvasBlocks.tsx:161)

## src/components/comments/Composer.tsx (1)

- never shown: `Mention a member` (src/components/comments/Composer.tsx:452)

## src/components/desktop/DesktopWindows.tsx (1)

- never shown: `Source on GitHub` (src/components/desktop/DesktopWindows.tsx:277)

## src/components/diagrams/DiagramEditor.tsx (6)

- never shown: `Diagram editor` (src/components/diagrams/DiagramEditor.tsx:415)
- never shown: `Diagram title` (src/components/diagrams/DiagramEditor.tsx:428)
- never shown: `Discard your changes?` (src/components/diagrams/DiagramEditor.tsx:669)
- never shown: `Reload theirs` (src/components/diagrams/DiagramEditor.tsx:533)
- never shown: `For admins: no draw.io editor is running` (src/components/diagrams/DiagramEditor.tsx:575)
- never shown: `Download .drawio` (src/components/diagrams/DiagramEditor.tsx:607, src/components/diagrams/DiagramEditor.tsx:616)

## src/components/diagrams/DiagramEmbed.tsx (3)

- never shown: `Diagram actions` (src/components/diagrams/DiagramEmbed.tsx:159)
- shown: `View full size` (src/components/diagrams/DiagramEmbed.tsx:180)
- never shown: `Text summary` (src/components/diagrams/DiagramEmbed.tsx:222)

## src/components/diagrams/DiagramSettingsSection.tsx (2)

- shown: `Where the draw.io editor runs` (src/components/diagrams/DiagramSettingsSection.tsx:63)
- shown: `Editor address` (src/components/diagrams/DiagramSettingsSection.tsx:89)

## src/components/diagrams/DiagramViewer.tsx (1)

- never shown: `…, full size` (src/components/diagrams/DiagramViewer.tsx:81)

## src/components/docs/AiChangedBar.tsx (1)

- never shown: `See changes` (src/components/docs/AiChangedBar.tsx:109)

## src/components/docs/CanvasPageView.tsx (2)

- shown: `Breadcrumb` (src/components/docs/CanvasPageView.tsx:40, src/components/docs/DocsPageView.tsx:355)
- never shown: `Page menu` (src/components/docs/CanvasPageView.tsx:72)

## src/components/docs/ConflictBanner.tsx (1)

- never shown: `Keep mine` (src/components/docs/ConflictBanner.tsx:90)

## src/components/docs/DocPeekPanel.tsx (2)

- never shown: `Doc preview` (src/components/docs/DocPeekPanel.tsx:143)
- never shown: `Show page top` (src/components/docs/DocPeekPanel.tsx:367)

## src/components/docs/DocsEditScreen.tsx (1)

- shown: `Editor mode` (src/components/docs/DocsEditScreen.tsx:502)

## src/components/docs/DocsFollowToggle.tsx (1)

- shown: `Following this space` (src/components/docs/DocsFollowToggle.tsx:13)

## src/components/docs/DocsHero.tsx (2)

- shown: `Choose files…` (src/components/docs/DocsHero.tsx:351, src/components/docs/ImportDialog.tsx:916)
- shown: `Choose folder…` (src/components/docs/DocsHero.tsx:359, src/components/docs/ImportDialog.tsx:919)

## src/components/docs/DocsMarkdown.tsx (1)

- shown: `Copy code` (src/components/docs/DocsMarkdown.tsx:200)

## src/components/docs/DocsPageView.tsx (1)

- shown: `On this page` (src/components/docs/DocsPageView.tsx:770, src/components/settings/SettingsPage.tsx:627)

## src/components/docs/DocsRail.tsx (3)

- shown: `Docs space (collapsed)` (src/components/docs/DocsRail.tsx:68)
- shown: `Expand page tree` (src/components/docs/DocsRail.tsx:88)
- shown: `Search pages` (src/components/docs/DocsRail.tsx:94)

## src/components/docs/DocsRecycleSection.tsx (1)

- never shown: `Deleted docs pages` (src/components/docs/DocsRecycleSection.tsx:355)

## src/components/docs/DocsStates.tsx (3)

- never shown: `Loading pages` (src/components/docs/DocsStates.tsx:40)
- never shown: `Loading page` (src/components/docs/DocsStates.tsx:83, src/components/docs/DocsStates.tsx:188, src/components/docs/DocsTree.tsx:730)
- never shown: `I need to read the API docs` (src/components/docs/DocsStates.tsx:658)

## src/components/docs/DocsSuggest.tsx (1)

- shown: `Link a page` (src/components/docs/DocsSuggest.tsx:240)

## src/components/docs/DocsTree.tsx (9)

- shown: `Resize page tree` (src/components/docs/DocsTree.tsx:135)
- shown: `Collapse` (src/components/docs/DocsTree.tsx:669, src/components/docs/ReferencedBy.tsx:173)
- never shown: `Expand` (src/components/docs/DocsTree.tsx:669, src/components/docs/ReferencedBy.tsx:173)
- never shown: `Saving move` (src/components/docs/DocsTree.tsx:730)
- shown: `Add child page under …` (src/components/docs/DocsTree.tsx:740)
- shown: `Page actions for …` (src/components/docs/DocsTree.tsx:754)
- shown: `Docs space` (src/components/docs/DocsTree.tsx:810)
- shown: `Collapse page tree` (src/components/docs/DocsTree.tsx:856)
- never shown: `Clear filter` (src/components/docs/DocsTree.tsx:908, src/components/docs/DocsTree.tsx:1003)

## src/components/docs/DocsView.tsx (1)

- shown: `Open Docs in its own window` (src/components/docs/DocsView.tsx:598)

## src/components/docs/DuplicateDialog.tsx (2)

- never shown: `Include child pages` (src/components/docs/DuplicateDialog.tsx:223)
- never shown: `Pages that will be created` (src/components/docs/DuplicateDialog.tsx:242)

## src/components/docs/FindInPage.tsx (1)

- shown: `Previous match` (src/components/docs/FindInPage.tsx:391, src/components/preview/TextReader.tsx:93)

## src/components/docs/GivePageDialog.tsx (1)

- never shown: `Check the error cases against the API` (src/components/docs/GivePageDialog.tsx:121)

## src/components/docs/HistoryDrawer.tsx (5)

- never shown: `Diff layout` (src/components/docs/HistoryDrawer.tsx:443)
- never shown: `Jump to a change` (src/components/docs/HistoryDrawer.tsx:534)
- shown: `Select version …` (src/components/docs/HistoryDrawer.tsx:629)
- never shown: `Inline` (src/components/docs/HistoryDrawer.tsx:453)
- never shown: `Side by side` (src/components/docs/HistoryDrawer.tsx:462)

## src/components/docs/ImportDialog.tsx (2)

- shown: `Files…` (src/components/docs/ImportDialog.tsx:1021)
- shown: `Folder…` (src/components/docs/ImportDialog.tsx:1024)

## src/components/docs/MoveToDialog.tsx (3)

- never shown: `Place here` (src/components/docs/MoveToDialog.tsx:401)
- never shown: `Find a page` (src/components/docs/MoveToDialog.tsx:525, src/components/docs/NewPageDialog.tsx:724)
- never shown: `Find a page…` (src/components/docs/MoveToDialog.tsx:526, src/components/docs/NewPageDialog.tsx:723)

## src/components/docs/NewPageDialog.tsx (2)

- shown: `Template` (src/components/docs/NewPageDialog.tsx:387)
- shown: `Write with AI` (src/components/docs/NewPageDialog.tsx:465)

## src/components/docs/OfflineBanners.tsx (1)

- never shown: `Retry now` (src/components/docs/OfflineBanners.tsx:31)

## src/components/docs/PageInfoPopover.tsx (2)

- never shown: `Page info` (src/components/docs/PageInfoPopover.tsx:104)
- shown: `Referenced by` (src/components/docs/PageInfoPopover.tsx:178, src/components/docs/ReferencedBy.tsx:151)

## src/components/docs/PageWork.tsx (1)

- never shown: `AI at work on this page` (src/components/docs/PageWork.tsx:41)

## src/components/docs/PublishDialog.tsx (4)

- never shown: `Publish page` (src/components/docs/PublishDialog.tsx:150)
- never shown: `Notify members` (src/components/docs/PublishDialog.tsx:382)
- never shown: `Review changes` (src/components/docs/PublishDialog.tsx:213)
- never shown: `Go to marker` (src/components/docs/PublishDialog.tsx:410)

## src/components/docs/RefChip.tsx (2)

- never shown: `Open in side panel` (src/components/docs/RefChip.tsx:764)
- shown: `Open page` (src/components/docs/RefChip.tsx:1035)

## src/components/docs/ReferencedBy.tsx (1)

- shown: `Open ticket` (src/components/docs/ReferencedBy.tsx:313)

## src/components/docs/RenameDialog.tsx (1)

- never shown: `Rename only` (src/components/docs/RenameDialog.tsx:113)

## src/components/docs/SearchPalette.tsx (5)

- never shown: `Search or Ask` (src/components/docs/SearchPalette.tsx:652)
- never shown: `Search docs` (src/components/docs/SearchPalette.tsx:1719, src/components/docs/SearchResults.tsx:528)
- never shown: `Show them` (src/components/docs/SearchPalette.tsx:1368)
- never shown: `Esc` (src/components/docs/SearchPalette.tsx:1841)
- never shown: `Linking syntax: [[Page#Section]], KAN-12 and anchors →` (src/components/docs/SearchPalette.tsx:1852)

## src/components/docs/SearchResults.tsx (16)

- never shown: `Search … docs…` (src/components/docs/SearchResults.tsx:527)
- never shown: `Clear search` (src/components/docs/SearchResults.tsx:544)
- never shown: `Search scope` (src/components/docs/SearchResults.tsx:584)
- never shown: `Search within results…` (src/components/docs/SearchResults.tsx:640)
- never shown: `Search within results` (src/components/docs/SearchResults.tsx:641)
- never shown: `Edited since` (src/components/docs/SearchResults.tsx:752)
- never shown: `Page tree location` (src/components/docs/SearchResults.tsx:784)
- never shown: `Only pages that link a ticket` (src/components/docs/SearchResults.tsx:821)
- never shown: `Remove edited filter` (src/components/docs/SearchResults.tsx:864)
- shown: `This space` (src/components/docs/SearchResults.tsx:589)
- never shown: `All projects` (src/components/docs/SearchResults.tsx:590)
- never shown: `Tickets` (src/components/docs/SearchResults.tsx:591)
- never shown: `Relevance` (src/components/docs/SearchResults.tsx:666)
- never shown: `Recently edited` (src/components/docs/SearchResults.tsx:673)
- never shown: `Clear all` (src/components/docs/SearchResults.tsx:699)
- never shown: `Anywhere in space` (src/components/docs/SearchResults.tsx:789)

## src/components/docs/SharePopover.tsx (2)

- never shown: `Share page` (src/components/docs/SharePopover.tsx:110)
- never shown: `Copy reference` (src/components/docs/SharePopover.tsx:228)

## src/components/docs/SinceViewedBanner.tsx (2)

- never shown: `Mark changed paragraphs in the page` (src/components/docs/SinceViewedBanner.tsx:138)
- never shown: `Mark as seen` (src/components/docs/SinceViewedBanner.tsx:259)

## src/components/docs/TicketDocsSection.tsx (4)

- never shown: `Remove link` (src/components/docs/TicketDocsSection.tsx:161)
- shown: `Link a doc` (src/components/docs/TicketDocsSection.tsx:249)
- never shown: `Search pages and sections` (src/components/docs/TicketDocsSection.tsx:287)
- shown: `Team` (src/components/docs/TicketDocsSection.tsx:381)

## src/components/docs/ai/CheckThisPage.tsx (1)

- shown: `Check this page` (src/components/docs/ai/CheckThisPage.tsx:200)

## src/components/docs/ai/CreateTicketsDialog.tsx (5)

- never shown: `Create tickets` (src/components/docs/ai/CreateTicketsDialog.tsx:131)
- never shown: `Create ticket …` (src/components/docs/ai/CreateTicketsDialog.tsx:188)
- never shown: `Type of ticket …` (src/components/docs/ai/CreateTicketsDialog.tsx:219)
- never shown: `Project of ticket …` (src/components/docs/ai/CreateTicketsDialog.tsx:231)
- never shown: `Column of ticket …` (src/components/docs/ai/CreateTicketsDialog.tsx:243)

## src/components/docs/ai/DocsAiSettings.tsx (2)

- shown: `Style guide page` (src/components/docs/ai/DocsAiSettings.tsx:98)
- shown: `First AI team (default)` (src/components/docs/ai/DocsAiSettings.tsx:83)

## src/components/docs/ai/DocsHealthView.tsx (5)

- never shown: `Page to link … to` (src/components/docs/ai/DocsHealthView.tsx:178)
- never shown: `Add to a page` (src/components/docs/ai/DocsHealthView.tsx:170)
- never shown: `Pick a page…` (src/components/docs/ai/DocsHealthView.tsx:190)
- never shown: `Review` (src/components/docs/ai/DocsHealthView.tsx:267, src/components/docs/ai/DocsHealthView.tsx:343, src/components/ideas/IdeaAiExtras.tsx:691)
- never shown: `Not needed` (src/components/docs/ai/DocsHealthView.tsx:310)

## src/components/docs/ai/DrawDiagram.tsx (2)

- never shown: `What should change? e.g. add a cache between the API and the database` (src/components/docs/ai/DrawDiagram.tsx:111)
- never shown: `What should it show? (optional)` (src/components/docs/ai/DrawDiagram.tsx:111)

## src/components/docs/ai/ExplainCard.tsx (1)

- never shown: `Explanation by AI` (src/components/docs/ai/ExplainCard.tsx:39)

## src/components/docs/ai/FreshnessBanner.tsx (1)

- never shown: `This page may be out of date` (src/components/docs/ai/FreshnessBanner.tsx:158)

## src/components/docs/ai/HistorySummary.tsx (1)

- never shown: `Summarise changes since` (src/components/docs/ai/HistorySummary.tsx:91)

## src/components/docs/ai/NeedsInput.tsx (2)

- never shown: `Gaps and sources` (src/components/docs/ai/NeedsInput.tsx:68)
- never shown: `Find […] in the text` (src/components/docs/ai/NeedsInput.tsx:149)

## src/components/docs/ai/PageAiMenu.tsx (1)

- never shown: `‹ Back` (src/components/docs/ai/PageAiMenu.tsx:195)

## src/components/docs/ai/SelectionAi.tsx (2)

- never shown: `Explain` (src/components/docs/ai/SelectionAi.tsx:35)
- never shown: `Summarise` (src/components/docs/ai/SelectionAi.tsx:43)

## src/components/docs/ai/SummaryBlock.tsx (1)

- never shown: `Summary by AI` (src/components/docs/ai/SummaryBlock.tsx:20)

## src/components/docs/ai/TranslateView.tsx (1)

- never shown: `Choose a section` (src/components/docs/ai/TranslateView.tsx:76, src/components/docs/ai/TranslateView.tsx:81)

## src/components/docs/ai/WriteWithAi.tsx (7)

- never shown: `Find…` (src/components/docs/ai/WriteWithAi.tsx:112)
- never shown: `Loading ideas…` (src/components/docs/ai/WriteWithAi.tsx:188)
- never shown: `Pick an idea` (src/components/docs/ai/WriteWithAi.tsx:188)
- never shown: `notes` (src/components/docs/ai/WriteWithAi.tsx:199, src/components/docs/ai/WriteWithAi.tsx:201)
- never shown: `Your notes` (src/components/docs/ai/WriteWithAi.tsx:199)
- never shown: `Paste the notes here: a meeting, a call, a brain dump` (src/components/docs/ai/WriteWithAi.tsx:201)
- shown: `What kind of page` (src/components/docs/ai/WriteWithAi.tsx:222)

## src/components/docs/comments/CommentBox.tsx (1)

- shown: `Attach an image or file` (src/components/docs/comments/CommentBox.tsx:271)

## src/components/docs/comments/CommentsPanel.tsx (3)

- shown: `Inline comments` (src/components/docs/comments/CommentsPanel.tsx:89)
- shown: `Close comments` (src/components/docs/comments/CommentsPanel.tsx:100)
- shown: `Show resolved` (src/components/docs/comments/CommentsPanel.tsx:158)

## src/components/docs/comments/DocsMentionIntent.tsx (1)

- never shown: `What does the mention mean` (src/components/docs/comments/DocsMentionIntent.tsx:79)

## src/components/docs/comments/OrphanWarning.tsx (3)

- never shown: `Publish with orphaned comments` (src/components/docs/comments/OrphanWarning.tsx:44)
- never shown: `Review comments` (src/components/docs/comments/OrphanWarning.tsx:83)
- never shown: `Publish anyway` (src/components/docs/comments/OrphanWarning.tsx:86)

## src/components/docs/comments/PageComments.tsx (1)

- shown: `Page comments` (src/components/docs/comments/PageComments.tsx:30)

## src/components/docs/comments/SelectionComment.tsx (1)

- never shown: `New comment` (src/components/docs/comments/SelectionComment.tsx:166)

## src/components/docs/comments/SendToAi.tsx (4)

- never shown: `Send comments to an AI` (src/components/docs/comments/SendToAi.tsx:275)
- never shown: `Find any ticket of the project` (src/components/docs/comments/SendToAi.tsx:392, src/components/docs/comments/SendToAi.tsx:393)
- shown: `Choose where to send this thread` (src/components/docs/comments/SendToAi.tsx:564)
- never shown: `add one in Members` (src/components/docs/comments/SendToAi.tsx:419)

## src/components/docs/comments/ThreadCard.tsx (3)

- shown: `Reply` (src/components/docs/comments/ThreadCard.tsx:315)
- shown: `Comment actions` (src/components/docs/comments/ThreadCard.tsx:329)
- never shown: `Delete this comment?` (src/components/docs/comments/ThreadCard.tsx:396)

## src/components/docs/editor/BubbleToolbar.tsx (2)

- never shown: `Link URL` (src/components/docs/editor/BubbleToolbar.tsx:206)
- never shown: `Paste or type a link` (src/components/docs/editor/BubbleToolbar.tsx:208)

## src/components/docs/editor/DocsEditor.tsx (4)

- shown: `Add block` (src/components/docs/editor/DocsEditor.tsx:812)
- shown: `Drag to move` (src/components/docs/editor/DocsEditor.tsx:828)
- shown: `Upload image` (src/components/docs/editor/DocsEditor.tsx:927)
- shown: `Attach a file` (src/components/docs/editor/DocsEditor.tsx:939)

## src/components/docs/editor/EditorErrorBoundary.tsx (1)

- never shown: `Reload the editor` (src/components/docs/editor/EditorErrorBoundary.tsx:54)

## src/components/docs/editor/RefSuggester.tsx (2)

- never shown: `Link a page or ticket` (src/components/docs/editor/RefSuggester.tsx:318)
- never shown: `Syntax help` (src/components/docs/editor/RefSuggester.tsx:557)

## src/components/docs/editor/SlashMenu.tsx (1)

- never shown: `Insert block` (src/components/docs/editor/SlashMenu.tsx:157)

## src/components/docs/editor/TableControls.tsx (3)

- shown: `Select column …` (src/components/docs/editor/TableControls.tsx:196)
- shown: `Select row …` (src/components/docs/editor/TableControls.tsx:217)
- never shown: `Header row` (src/components/docs/editor/TableControls.tsx:320)

## src/components/icons/AppLogo.tsx (1)

- shown: `Kanban logo` (src/components/icons/AppLogo.tsx:43)

## src/components/icons/StatusMarks.tsx (2)

- never shown: `Due date` (src/components/icons/StatusMarks.tsx:21)
- never shown: `Overdue` (src/components/icons/StatusMarks.tsx:46)

## src/components/icons/TestCaseMarks.tsx (4)

- never shown: `Pass` (src/components/icons/TestCaseMarks.tsx:40)
- never shown: `Fail` (src/components/icons/TestCaseMarks.tsx:59)
- never shown: `Running — live` (src/components/icons/TestCaseMarks.tsx:91)
- shown: `Pending` (src/components/icons/TestCaseMarks.tsx:120)

## src/components/icons/WorkspaceMarks.tsx (2)

- never shown: `Auto-delete pending` (src/components/icons/WorkspaceMarks.tsx:43)
- never shown: `Kept forever` (src/components/icons/WorkspaceMarks.tsx:66)

## src/components/ideas/IdeaAiExtras.tsx (3)

- shown: `AI advice in triage` (src/components/ideas/IdeaAiExtras.tsx:228)
- never shown: `Ask again` (src/components/ideas/IdeaAiExtras.tsx:348)
- shown: `Open Inbox` (src/components/ideas/IdeaAiExtras.tsx:657, src/components/ideas/IdeaAiExtras.tsx:685)

## src/components/ideas/IdeaAiPanel.tsx (4)

- shown: `Shape with AI` (src/components/ideas/IdeaAiPanel.tsx:450)
- never shown: `Ask about this idea` (src/components/ideas/IdeaAiPanel.tsx:596)
- never shown: `Cheapest test for each assumption` (src/components/ideas/IdeaAiPanel.tsx:580)
- shown: `Open chat` (src/components/ideas/IdeaAiPanel.tsx:636)

## src/components/ideas/IdeaAssumptions.tsx (6)

- never shown: `Assumption text` (src/components/ideas/IdeaAssumptions.tsx:152)
- never shown: `Close the assumption` (src/components/ideas/IdeaAssumptions.tsx:237)
- shown: `Open the assumption` (src/components/ideas/IdeaAssumptions.tsx:237)
- shown: `Edit assumption` (src/components/ideas/IdeaAssumptions.tsx:248)
- shown: `Delete assumption` (src/components/ideas/IdeaAssumptions.tsx:255)
- shown: `Create test` (src/components/ideas/IdeaAssumptions.tsx:221)

## src/components/ideas/IdeaCapture.tsx (5)

- never shown: `Add details or paste a picture` (src/components/ideas/IdeaCapture.tsx:333)
- never shown: `Start with a sketch` (src/components/ideas/IdeaCapture.tsx:344)
- never shown: `Start with a canvas` (src/components/ideas/IdeaCapture.tsx:356)
- never shown: `Markdown. Paste a screenshot with Ctrl+V.` (src/components/ideas/IdeaCapture.tsx:372)
- never shown: `Add to it instead` (src/components/ideas/IdeaCapture.tsx:381)

## src/components/ideas/IdeaDiscussion.tsx (10)

- never shown: `Edit comment` (src/components/ideas/IdeaDiscussion.tsx:97)
- never shown: `Write a comment` (src/components/ideas/IdeaDiscussion.tsx:126)
- never shown: `shipped` (src/components/ideas/IdeaDiscussion.tsx:127)
- never shown: `Comments stay open after shipping.` (src/components/ideas/IdeaDiscussion.tsx:127)
- never shown: `Kind of entry` (src/components/ideas/IdeaDiscussion.tsx:298)
- never shown: `Write what you found, tried or decided… (markdown)` (src/components/ideas/IdeaDiscussion.tsx:322)
- never shown: `Link to assumption` (src/components/ideas/IdeaDiscussion.tsx:379)
- never shown: `Pin` (src/components/ideas/IdeaDiscussion.tsx:446)
- never shown: `Use as evidence` (src/components/ideas/IdeaDiscussion.tsx:505)
- never shown: `Add to log` (src/components/ideas/IdeaDiscussion.tsx:400)

## src/components/ideas/IdeaEvidenceTab.tsx (5)

- shown: `link` (src/components/ideas/IdeaEvidenceTab.tsx:119)
- never shown: `ticket` (src/components/ideas/IdeaEvidenceTab.tsx:119)
- never shown: `KAN-198` (src/components/ideas/IdeaEvidenceTab.tsx:119)
- never shown: `note` (src/components/ideas/IdeaEvidenceTab.tsx:119)
- never shown: `Draw a sketch` (src/components/ideas/IdeaEvidenceTab.tsx:148)

## src/components/ideas/IdeaList.tsx (2)

- shown: `Ideas` (src/components/ideas/IdeaList.tsx:182, src/components/sketch/SketchAiPanel.tsx:569)
- never shown: `Assign` (src/components/ideas/IdeaList.tsx:225)

## src/components/ideas/IdeaMatrix.tsx (2)

- shown: `Assumptions by impact and evidence` (src/components/ideas/IdeaMatrix.tsx:116)
- shown: `Selected assumption` (src/components/ideas/IdeaMatrix.tsx:160)

## src/components/ideas/IdeaPage.tsx (11)

- shown: `Idea sections` (src/components/ideas/IdeaPage.tsx:373)
- shown: `Decide` (src/components/ideas/IdeaPage.tsx:418)
- shown: `Nobody yet` (src/components/ideas/IdeaPage.tsx:474)
- shown: `Small, medium, big…` (src/components/ideas/IdeaPage.tsx:493)
- shown: `…: …. Change` (src/components/ideas/IdeaPage.tsx:652)
- never shown: `Choose a project` (src/components/ideas/IdeaPage.tsx:840, src/components/ideas/IdeaPage.tsx:853)
- never shown: `Merge into another idea…` (src/components/ideas/IdeaPage.tsx:270)
- never shown: `Partly` (src/components/ideas/IdeaPage.tsx:734)
- never shown: `See the evidence` (src/components/ideas/IdeaPage.tsx:803)
- shown: `Park` (src/components/ideas/IdeaPage.tsx:818, src/components/ideas/TriageDialogs.tsx:292)
- never shown: `Choose a project…` (src/components/ideas/IdeaPage.tsx:844)

## src/components/ideas/IdeaSpace.tsx (10)

- shown: `Search ideas` (src/components/ideas/IdeaSpace.tsx:345, src/components/ideas/IdeaSpace.tsx:348, src/components/ideas/TriageDialogs.tsx:511)
- shown: `Sort` (src/components/ideas/IdeaSpace.tsx:420)
- shown: `Source: all` (src/components/ideas/IdeaSpace.tsx:400)
- shown: `Tag: all` (src/components/ideas/IdeaSpace.tsx:408)
- shown: `Sort: readiness` (src/components/ideas/IdeaSpace.tsx:422)
- shown: `Sort: updated` (src/components/ideas/IdeaSpace.tsx:423)
- shown: `Sort: newest` (src/components/ideas/IdeaSpace.tsx:424)
- shown: `Sort: demand` (src/components/ideas/IdeaSpace.tsx:425)
- shown: `Sort: title` (src/components/ideas/IdeaSpace.tsx:426)
- shown: `New idea` (src/components/ideas/IdeaSpace.tsx:448)

## src/components/ideas/IdeaSpaceSettings.tsx (2)

- shown: `Use the web` (src/components/ideas/IdeaSpaceSettings.tsx:134)
- shown: `Change` (src/components/ideas/IdeaSpaceSettings.tsx:102)

## src/components/ideas/PromoteDialog.tsx (7)

- never shown: `Ticket title` (src/components/ideas/PromoteDialog.tsx:225)
- never shown: `Sub-ticket title` (src/components/ideas/PromoteDialog.tsx:290)
- never shown: `Ticket description` (src/components/ideas/PromoteDialog.tsx:338)
- never shown: `Ticket description: click to edit` (src/components/ideas/PromoteDialog.tsx:345)
- never shown: `One ticket` (src/components/ideas/PromoteDialog.tsx:186)
- never shown: `Ticket with sub-tickets` (src/components/ideas/PromoteDialog.tsx:194)
- never shown: `+ Add a sub-ticket` (src/components/ideas/PromoteDialog.tsx:305)

## src/components/ideas/Triage.tsx (5)

- shown: `Inbox` (src/components/ideas/Triage.tsx:229)
- shown: `Idea in focus` (src/components/ideas/Triage.tsx:285)
- never shown: `Park all for a month` (src/components/ideas/Triage.tsx:214)
- never shown: `Merge into it` (src/components/ideas/Triage.tsx:327)
- shown: `Open the page` (src/components/ideas/Triage.tsx:365)

## src/components/ideas/TriageDialogs.tsx (9)

- shown: `Project` (src/components/ideas/TriageDialogs.tsx:32)
- never shown: `Add a tag` (src/components/ideas/TriageDialogs.tsx:123)
- never shown: `Ask the Idea AI to suggest a problem statement and assumptions` (src/components/ideas/TriageDialogs.tsx:231)
- never shown: `Pick a date` (src/components/ideas/TriageDialogs.tsx:342)
- never shown: `Why now is a bad time` (src/components/ideas/TriageDialogs.tsx:352)
- never shown: `Reason` (src/components/ideas/TriageDialogs.tsx:410)
- never shown: `Search ideas to merge into` (src/components/ideas/TriageDialogs.tsx:510)
- never shown: `Idea to merge into` (src/components/ideas/TriageDialogs.tsx:514)
- never shown: `No project` (src/components/ideas/TriageDialogs.tsx:35)

## src/components/ideas/ideaLinks.tsx (4)

- never shown: `Started as idea …` (src/components/ideas/ideaLinks.tsx:42)
- never shown: `Started as an idea` (src/components/ideas/ideaLinks.tsx:118)
- never shown: `Tests an assumption` (src/components/ideas/ideaLinks.tsx:207)
- never shown: `Idea activity` (src/components/ideas/ideaLinks.tsx:169)

## src/components/notifications/AllNotificationsPage.tsx (6)

- shown: `Search notifications…` (src/components/notifications/AllNotificationsPage.tsx:152)
- shown: `Search notifications` (src/components/notifications/AllNotificationsPage.tsx:153)
- shown: `Days` (src/components/notifications/AllNotificationsPage.tsx:172)
- shown: `Last 7 days` (src/components/notifications/AllNotificationsPage.tsx:178)
- shown: `Last 30 days` (src/components/notifications/AllNotificationsPage.tsx:179)
- shown: `Last 90 days` (src/components/notifications/AllNotificationsPage.tsx:180)

## src/components/notifications/NotificationPanel.tsx (2)

- never shown: `Needs you` (src/components/notifications/NotificationPanel.tsx:167)
- never shown: `Updates` (src/components/notifications/NotificationPanel.tsx:176)

## src/components/notifications/NotificationRow.tsx (7)

- shown: `Unread` (src/components/notifications/NotificationRow.tsx:154)
- never shown: `Type your answer…` (src/components/notifications/NotificationRow.tsx:300)
- never shown: `Your answer` (src/components/notifications/NotificationRow.tsx:301)
- never shown: `Mute this ticket` (src/components/notifications/NotificationRow.tsx:446)
- never shown: `Send answer` (src/components/notifications/NotificationRow.tsx:305)
- never shown: `Turn this kind off` (src/components/notifications/NotificationRow.tsx:476)
- never shown: `Bring back now` (src/components/notifications/NotificationRow.tsx:612)

## src/components/notifications/NotificationStates.tsx (1)

- never shown: `Loading notifications` (src/components/notifications/NotificationStates.tsx:21)

## src/components/preview/ArchiveReader.tsx (3)

- never shown: `Location in archive` (src/components/preview/ArchiveReader.tsx:143)
- never shown: `Contents of …` (src/components/preview/ArchiveReader.tsx:188)
- never shown: `Download this file` (src/components/preview/ArchiveReader.tsx:34)

## src/components/preview/HtmlReader.tsx (1)

- never shown: `HTML view` (src/components/preview/HtmlReader.tsx:35)

## src/components/preview/ImageReader.tsx (2)

- never shown: `Image controls` (src/components/preview/ImageReader.tsx:319)
- never shown: `Rotate` (src/components/preview/ImageReader.tsx:342)

## src/components/preview/JsonReader.tsx (1)

- never shown: `JSON view` (src/components/preview/JsonReader.tsx:91)

## src/components/preview/MarkdownReader.tsx (2)

- never shown: `Markdown view` (src/components/preview/MarkdownReader.tsx:25)
- never shown: `Rendered` (src/components/preview/MarkdownReader.tsx:26)

## src/components/preview/OfficeReader.tsx (2)

- never shown: `Slides` (src/components/preview/OfficeReader.tsx:229)
- never shown: `Slide …: …` (src/components/preview/OfficeReader.tsx:236)

## src/components/preview/PdfReader.tsx (1)

- never shown: `PDF pages` (src/components/preview/PdfReader.tsx:325)

## src/components/preview/PreviewViewer.tsx (11)

- never shown: `Preview of …` (src/components/preview/PreviewViewer.tsx:380)
- never shown: `File … of …` (src/components/preview/PreviewViewer.tsx:422)
- never shown: `Draw on it` (src/components/preview/PreviewViewer.tsx:437)
- never shown: `Download and open` (src/components/preview/PreviewViewer.tsx:471)
- never shown: `Open in app` (src/components/preview/PreviewViewer.tsx:486, src/components/preview/PreviewViewer.tsx:286)
- never shown: `Show in folder` (src/components/preview/PreviewViewer.tsx:497)
- never shown: `Copied` (src/components/preview/PreviewViewer.tsx:507)
- never shown: `Full screen` (src/components/preview/PreviewViewer.tsx:517)
- never shown: `Previous file` (src/components/preview/PreviewViewer.tsx:536)
- never shown: `Close details` (src/components/preview/PreviewViewer.tsx:565)
- never shown: `Files in this place` (src/components/preview/PreviewViewer.tsx:620)

## src/components/preview/SlideCanvas.tsx (1)

- never shown: `Slide` (src/components/preview/SlideCanvas.tsx:326)

## src/components/preview/TableReader.tsx (2)

- never shown: `… table` (src/components/preview/TableReader.tsx:153)
- never shown: `Download all rows` (src/components/preview/TableReader.tsx:116)

## src/components/preview/TextReader.tsx (2)

- never shown: `File contents` (src/components/preview/TextReader.tsx:274)
- never shown: `Show all` (src/components/preview/TextReader.tsx:283)

## src/components/preview/XlsxReader.tsx (1)

- never shown: `Sheets` (src/components/preview/XlsxReader.tsx:424)

## src/components/schedules/MemberSelect.tsx (4)

- never shown: `Time zone` (src/components/schedules/MemberSelect.tsx:169, src/components/schedules/MemberSelect.tsx:204)
- never shown: `Search a city or zone…` (src/components/schedules/MemberSelect.tsx:179)
- never shown: `Search time zones` (src/components/schedules/MemberSelect.tsx:180)
- never shown: `Search by key or title…` (src/components/schedules/MemberSelect.tsx:317)

## src/components/schedules/ScheduleDetail.tsx (7)

- never shown: `Another team` (src/components/schedules/ScheduleDetail.tsx:106)
- never shown: `Schedule` (src/components/schedules/ScheduleDetail.tsx:324)
- never shown: `Filter runs` (src/components/schedules/ScheduleDetail.tsx:524)
- never shown: `Pick a team…` (src/components/schedules/ScheduleDetail.tsx:109)
- never shown: `Run on it` (src/components/schedules/ScheduleDetail.tsx:116)
- never shown: `Run on another team` (src/components/schedules/ScheduleDetail.tsx:127)
- never shown: `PR` (src/components/schedules/ScheduleDetail.tsx:205)

## src/components/schedules/ScheduleEditor.tsx (5)

- never shown: `Edit schedule` (src/components/schedules/ScheduleEditor.tsx:328)
- never shown: `runs` (src/components/schedules/ScheduleEditor.tsx:460)
- never shown: `Do not tell …` (src/components/schedules/ScheduleEditor.tsx:679)
- never shown: `Add people` (src/components/schedules/ScheduleEditor.tsx:692, src/components/schedules/ScheduleEditor.tsx:695)
- never shown: `Keep the change small. Write the summary in plain words and name the test you added.` (src/components/schedules/ScheduleEditor.tsx:709)

## src/components/schedules/ScheduleTicketBlock.tsx (1)

- never shown: `All runs` (src/components/schedules/ScheduleTicketBlock.tsx:130)

## src/components/schedules/SchedulesTab.tsx (4)

- shown: `Show` (src/components/schedules/SchedulesTab.tsx:461)
- never shown: `Previous week` (src/components/schedules/SchedulesTab.tsx:499)
- never shown: `Next week` (src/components/schedules/SchedulesTab.tsx:509)
- never shown: `Today` (src/components/schedules/SchedulesTab.tsx:515)

## src/components/settings/DiagnosticsPage.tsx (4)

- shown: `Info and above` (src/components/settings/DiagnosticsPage.tsx:108)
- shown: `Warnings and errors` (src/components/settings/DiagnosticsPage.tsx:109)
- shown: `Errors only` (src/components/settings/DiagnosticsPage.tsx:110)
- shown: `Everything` (src/components/settings/DiagnosticsPage.tsx:111)

## src/components/settings/NotificationsSettings.tsx (7)

- shown: `Days of the day card` (src/components/settings/NotificationsSettings.tsx:592)
- shown: `send a test` (src/components/settings/NotificationsSettings.tsx:253)
- never shown: `Allow in this browser` (src/components/settings/NotificationsSettings.tsx:263)
- never shown: `Send a test` (src/components/settings/NotificationsSettings.tsx:273, src/components/settings/NotificationsSettings.tsx:454, src/components/settings/NotificationsSettings.tsx:469)
- never shown: `Open System Settings` (src/components/settings/NotificationsSettings.tsx:451)
- shown: `Play` (src/components/settings/NotificationsSettings.tsx:549)
- shown: `Unmute` (src/components/settings/NotificationsSettings.tsx:672)

## src/components/settings/ProjectRepoRow.tsx (1)

- shown: `Unlink` (src/components/settings/ProjectRepoRow.tsx:74)

## src/components/settings/SettingsPage.tsx (7)

- shown: `Project to edit: …` (src/components/settings/SettingsPage.tsx:438)
- never shown: `Projects` (src/components/settings/SettingsPage.tsx:448)
- never shown: `Settings found` (src/components/settings/SettingsPage.tsx:536)
- shown: `Settings page` (src/components/settings/SettingsPage.tsx:578)
- shown: `Settings pages` (src/components/settings/SettingsPage.tsx:588)
- shown: `On this page (narrow window)` (src/components/settings/SettingsPage.tsx:610)
- shown: `Theme` (src/components/settings/SettingsPage.tsx:669)

## src/components/settings/StoragePage.tsx (5)

- shown: `Data folder path` (src/components/settings/StoragePage.tsx:149)
- never shown: `Loading…` (src/components/settings/StoragePage.tsx:150)
- shown: `/Users/you/kanban-data` (src/components/settings/StoragePage.tsx:150)
- never shown: `Confirm import` (src/components/settings/StoragePage.tsx:220)
- never shown: `Replace my data` (src/components/settings/StoragePage.tsx:233)

## src/components/settings/WorkspaceSettingsSection.tsx (2)

- shown: `Workspace root path` (src/components/settings/WorkspaceSettingsSection.tsx:105)
- never shown: `Delete them` (src/components/settings/WorkspaceSettingsSection.tsx:160)

## src/components/settings/database/ConnectionForm.tsx (3)

- never shown: `…://user:password@host:…/kanban` (src/components/settings/database/ConnectionForm.tsx:152)
- never shown: `fill in the fields` (src/components/settings/database/ConnectionForm.tsx:275)
- shown: `paste a connection string` (src/components/settings/database/ConnectionForm.tsx:282)

## src/components/settings/database/DatabaseCard.tsx (1)

- never shown: `Use the SQLite file again` (src/components/settings/database/DatabaseCard.tsx:257)

## src/components/settings/database/MoveCheckStep.tsx (1)

- never shown: `What goes into the new database` (src/components/settings/database/MoveCheckStep.tsx:216)

## src/components/settings/database/MoveCopyStep.tsx (3)

- never shown: `Cancel the copy` (src/components/settings/database/MoveCopyStep.tsx:86, src/components/settings/database/MoveStopped.tsx:354)
- never shown: `Copy progress` (src/components/settings/database/MoveCopyStep.tsx:318)
- never shown: `Start again` (src/components/settings/database/MoveCopyStep.tsx:169)

## src/components/settings/database/MoveStopped.tsx (1)

- never shown: `Would TEXT be enough instead of LONGTEXT?` (src/components/settings/database/MoveStopped.tsx:318)

## src/components/settings/database/MoveVerifyStep.tsx (1)

- never shown: `Same` (src/components/settings/database/MoveVerifyStep.tsx:139)

## src/components/settings/database/MoveWhereStep.tsx (2)

- never shown: `Database engine` (src/components/settings/database/MoveWhereStep.tsx:57)
- never shown: `Why?` (src/components/settings/database/MoveWhereStep.tsx:95)

## src/components/settings/database/dbUi.tsx (1)

- shown: `Steps` (src/components/settings/database/dbUi.tsx:371)

## src/components/sketch/NewSketchDialog.tsx (3)

- never shown: `New sketch` (src/components/sketch/NewSketchDialog.tsx:29)
- never shown: `Size` (src/components/sketch/NewSketchDialog.tsx:31)
- shown: `Background` (src/components/sketch/NewSketchDialog.tsx:53)

## src/components/sketch/SketchAiPanel.tsx (10)

- never shown: `Shapes from the AI` (src/components/sketch/SketchAiPanel.tsx:486)
- shown: `AI help` (src/components/sketch/SketchAiPanel.tsx:617, src/components/sketch/SketchEditor.tsx:627)
- never shown: `Close AI help` (src/components/sketch/SketchAiPanel.tsx:663)
- never shown: `Conversation about this drawing` (src/components/sketch/SketchAiPanel.tsx:710)
- never shown: `Ask, or say what to draw…` (src/components/sketch/SketchAiPanel.tsx:801)
- never shown: `Message to the AI` (src/components/sketch/SketchAiPanel.tsx:802)
- never shown: `Attach a picture or a text file` (src/components/sketch/SketchAiPanel.tsx:843)
- never shown: `Put on the drawing` (src/components/sketch/SketchAiPanel.tsx:151)
- never shown: `Show on the drawing` (src/components/sketch/SketchAiPanel.tsx:545)
- never shown: `What will be sent` (src/components/sketch/SketchAiPanel.tsx:734)

## src/components/sketch/SketchEditor.tsx (6)

- shown: `Fit to window` (src/components/sketch/SketchEditor.tsx:615)
- shown: `Colour` (src/components/sketch/SketchEditor.tsx:765, src/components/sketch/SketchPanels.tsx:397)
- shown: `Layers` (src/components/sketch/SketchEditor.tsx:774, src/components/sketch/SketchPanels.tsx:472)
- shown: `Text` (src/components/sketch/SketchEditor.tsx:799)
- never shown: `Save your drawing?` (src/components/sketch/SketchEditor.tsx:866)
- shown: `Crop and resize` (src/components/sketch/SketchEditor.tsx:728)

## src/components/sketch/SketchEmbed.tsx (2)

- shown: `Sketch actions` (src/components/sketch/SketchEmbed.tsx:115)
- shown: `View large` (src/components/sketch/SketchEmbed.tsx:132)

## src/components/sketch/SketchPanels.tsx (19)

- shown: `… options` (src/components/sketch/SketchPanels.tsx:186)
- never shown: `Width` (src/components/sketch/SketchPanels.tsx:337)
- never shown: `Height` (src/components/sketch/SketchPanels.tsx:346)
- shown: `Colour picker` (src/components/sketch/SketchPanels.tsx:406)
- shown: `Colour as hex` (src/components/sketch/SketchPanels.tsx:412)
- shown: `Colour …` (src/components/sketch/SketchPanels.tsx:434)
- shown: `Recent colour …` (src/components/sketch/SketchPanels.tsx:450)
- shown: `Add layer` (src/components/sketch/SketchPanels.tsx:484)
- never shown: `Layer name` (src/components/sketch/SketchPanels.tsx:513)
- shown: `Move layer up` (src/components/sketch/SketchPanels.tsx:556)
- shown: `Move layer down` (src/components/sketch/SketchPanels.tsx:565)
- shown: `Merge down` (src/components/sketch/SketchPanels.tsx:574)
- shown: `Delete layer` (src/components/sketch/SketchPanels.tsx:584)
- shown: `Layer opacity` (src/components/sketch/SketchPanels.tsx:600)
- never shown: `Put down (Enter)` (src/components/sketch/SketchPanels.tsx:322)
- never shown: `Resize canvas` (src/components/sketch/SketchPanels.tsx:353)
- never shown: `Scale drawing` (src/components/sketch/SketchPanels.tsx:362)
- never shown: `Trim to content` (src/components/sketch/SketchPanels.tsx:365)
- never shown: `Crop to box` (src/components/sketch/SketchPanels.tsx:368)

## Keys pressed outside text fields

/, Alt+Alt, Alt+n, ArrowRight, Ctrl+A, Ctrl+Control, Ctrl+End, Ctrl+Enter, Ctrl+a, Ctrl+f, Ctrl+j, Ctrl+k, Enter, Escape, p

