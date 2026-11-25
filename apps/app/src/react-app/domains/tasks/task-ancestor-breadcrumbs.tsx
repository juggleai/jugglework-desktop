import { ChevronRight } from "lucide-react";

import { DenApiError, type DenClient, type DenProductTask } from "@/app/lib/den";
import { t } from "@/i18n";
import { useProductTask, type ProductTaskScope } from "./task-queries";

type TaskAncestorNavigation = {
  client: DenClient;
  scope: ProductTaskScope;
  onSelect: (taskId: string) => void;
};

export function TaskAncestorBreadcrumbs({ task, ...navigation }: TaskAncestorNavigation & { task: DenProductTask }) {
  const parent = task.parentTask;
  if (!parent || parent.id === task.id) return null;

  return <nav aria-label={t("tasks.parent_tasks")} className="has-[ol:empty]:hidden">
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <TaskAncestorCrumb {...navigation} parent={parent} descendantIds={[task.id]} />
    </ol>
  </nav>;
}

function TaskAncestorCrumb({ parent, descendantIds, ...navigation }: TaskAncestorNavigation & {
  parent: NonNullable<DenProductTask["parentTask"]>;
  descendantIds: string[];
}) {
  const { data, error, isError } = useProductTask({ client: navigation.client, scope: navigation.scope, taskId: parent.id });
  if (data && (data.tombstone || !data.permissions.canView)) return null;
  if (error instanceof DenApiError && (error.status === 403 || error.status === 404)) return null;

  const title = data?.task.title ?? parent.title;
  const next = isError ? undefined : data?.task.parentTask;
  const path = [...descendantIds, parent.id];

  return <>
    {next && !path.includes(next.id) ? <TaskAncestorCrumb {...navigation} parent={next} descendantIds={path} /> : null}
    <li className="flex min-w-0 max-w-full items-center gap-1 text-sm text-dls-secondary">
      <button type="button" title={title} onClick={() => navigation.onSelect(parent.id)} className="min-w-0 truncate rounded text-start hover:text-blue-10 hover:underline focus-visible:outline-2 focus-visible:outline-blue-8">
        {title}
      </button>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 opacity-60 rtl:rotate-180" />
    </li>
  </>;
}
