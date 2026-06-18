Project: rejections

## Constraints
- Don't do that

## Lessons
- Confirm proposed actions before executing: user_declined_tool (tool_result): "The user doesn't want to proceed with this tool use. The user wants you to answer a different question instead." [node_001, node_002, node_004]
- Validate tool inputs before executing: tool_execution_error (tool_result): "mkdir: cannot create directory '/root/.config/forbidden': File exists" [node_003]
- Pre-flight check filesystem and shell permissions: permission_denied (tool_result): "sudo: permission denied; user is not in the sudoers file. This incident will be reported." [node_003]
- Treat privacy boundaries as product requirements: Agent action touched risky-command [signals: risky command]: "sudo rm -rf /root/.config/forbidden" [node_003]
- Rephrase refused requests instead of repeating them: model_refusal (stop_reason) [node_004, node_005]
- Re-check the actual goal: User said: "stop, don't do that" [node_003]

## Security
- (high) [node_003] "sudo rm -rf /root/.config/forbidden"

## Next
- Continue: Try writing a new file via the Write tool.
- Constraint: stop, don't do that
