import config from "@/config";
import type { TaskType } from "@/types";

type PeriodicTaskDefinition = {
  taskType: TaskType;
  intervalSeconds: number;
  payload: Record<string, unknown>;
};

const PERIODIC_TASK_DEFINITIONS: PeriodicTaskDefinition[] = [
  { taskType: "check_due_connectors", intervalSeconds: 60, payload: {} },
  {
    taskType: "check_due_schedule_triggers",
    intervalSeconds: 60,
    payload: {},
  },
  {
    taskType: "check_mcp_image_updates",
    intervalSeconds: config.orchestrator.imageUpdateCheckIntervalSeconds,
    payload: {},
  },
];

export default PERIODIC_TASK_DEFINITIONS;
