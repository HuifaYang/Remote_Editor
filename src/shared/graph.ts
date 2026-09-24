// 提交图泳道布局（分册 1 · A7）：纯函数
import type { CommitInfo, GraphRow } from "./types.js";

function nonEmptyLanes(lanes: Array<string | null>): number[] {
  const out: number[] = [];
  for (let i = 0; i < lanes.length; i++) if (lanes[i] !== null) out.push(i);
  return out;
}

/**
 * 逐提交自上而下分配泳道：
 * 正在等待的提交用已有泳道；新分支顶端复用最左空位或新开；
 * 第一父写回本泳道，其余父各占一条；两条泳道等同同一提交时保留最左、其余置空（不左移）。
 */
export function layout(commits: CommitInfo[]): GraphRow[] {
  const lanes: Array<string | null> = [];
  const waiting = new Map<string, number>();
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const topLanes = nonEmptyLanes(lanes);   // 插入前

    let lane: number;
    const waited = waiting.get(commit.hash);
    if (waited !== undefined) {
      lane = waited;
      waiting.delete(commit.hash);
    } else {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lanes.push(null);
        lane = lanes.length - 1;
      }
    }
    lanes[lane] = commit.hash;               // 占位：本行圆点 + 防止父提交复用本泳道

    const parentLanes: number[] = [];
    const assignParent = (hash: string, preferred: number | null): void => {
      const existing = waiting.get(hash);
      let assigned: number;
      if (existing !== undefined) {
        if (preferred === null || existing < preferred) {
          if (preferred !== null) lanes[preferred] = null;   // 并线：保留最左，其余置空
          lanes[existing] = hash;
          assigned = existing;
        } else {
          lanes[existing] = null;
          lanes[preferred] = hash;
          waiting.set(hash, preferred);
          assigned = preferred;
        }
      } else {
        let l = preferred;
        if (l === null) {
          l = lanes.indexOf(null);
          if (l === -1) {
            lanes.push(null);
            l = lanes.length - 1;
          }
        }
        waiting.set(hash, l);
        lanes[l] = hash;
        assigned = l;
      }
      if (!parentLanes.includes(assigned)) parentLanes.push(assigned);
    };

    commit.parents.forEach((p, i) => assignParent(p, i === 0 ? lane : null));

    // 没有父提交接管的本泳道 → 置空（历史到头）
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) lanes[i] = null;
    }

    rows.push({
      commit,
      lane,
      topLanes,
      bottomLanes: nonEmptyLanes(lanes),
      parentLanes,
      laneCount: lanes.length,
    });
  }
  return rows;
}
