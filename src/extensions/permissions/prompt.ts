export const PERMISSION_TITLE = "Permission required";
export const YES = "Yes";
export const YES_SESSION = "Yes, allow for this session";
export const NO = "No";

export function permissionMessage(toolName: string, reason: string): string {
  return `Tool: ${toolName}\nReason: ${reason}\n\nAllow this tool call?`;
}
