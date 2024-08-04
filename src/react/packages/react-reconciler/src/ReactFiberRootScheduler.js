/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactInternalTypes';
import type {Lane} from './ReactFiberLane';
import type {PriorityLevel} from 'scheduler/src/SchedulerPriorities';
import type {BatchConfigTransition} from './ReactFiberTracingMarkerComponent';

import {
  disableLegacyMode,
  enableDeferRootSchedulingToMicrotask,
} from 'shared/ReactFeatureFlags';
import {
  NoLane,
  NoLanes,
  SyncLane,
  getHighestPriorityLane,
  getNextLanes,
  includesSyncLane,
  markStarvedLanesAsExpired,
  upgradePendingLaneToSync,
  claimNextTransitionLane,
} from './ReactFiberLane';
import {
  CommitContext,
  NoContext,
  RenderContext,
  getExecutionContext,
  getWorkInProgressRoot,
  getWorkInProgressRootRenderLanes,
  isWorkLoopSuspendedOnData,
  performConcurrentWorkOnRoot,
  performSyncWorkOnRoot,
} from './ReactFiberWorkLoop';
import {LegacyRoot} from './ReactRootTags';
import {
  ImmediatePriority as ImmediateSchedulerPriority,
  UserBlockingPriority as UserBlockingSchedulerPriority,
  NormalPriority as NormalSchedulerPriority,
  IdlePriority as IdleSchedulerPriority,
  cancelCallback as Scheduler_cancelCallback,
  scheduleCallback as Scheduler_scheduleCallback,
  now,
} from './Scheduler';
import {
  DiscreteEventPriority,
  ContinuousEventPriority,
  DefaultEventPriority,
  IdleEventPriority,
  lanesToEventPriority,
} from './ReactEventPriorities';
import {
  supportsMicrotasks,
  scheduleMicrotask,
  shouldAttemptEagerTransition,
} from './ReactFiberConfig';

import ReactSharedInternals from 'shared/ReactSharedInternals';

// A linked list of all the roots with pending work. In an idiomatic app,
// there's only a single root, but we do support multi root apps, hence this
// extra complexity. But this module is optimized for the single root case.
// 所有有待处理任务的根的链表。在符合习惯的应用程序中，只有一个根，
// 但我们确实支持多根应用程序，因此存在这种额外的复杂性。但此模块针对单根情况进行了优化。 
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

// Used to prevent redundant mircotasks from being scheduled.
// 用于防止安排冗余的微任务。 
let didScheduleMicrotask: boolean = false;
// `act` "microtasks" are scheduled on the `act` queue instead of an actual
// microtask, so we have to dedupe those separately. This wouldn't be an issue
// if we required all `act` calls to be awaited, which we might in the future.
let didScheduleMicrotask_act: boolean = false;

// Used to quickly bail out of flushSync if there's no sync work to do.
let mightHavePendingSyncWork: boolean = false;

let isFlushingWork: boolean = false;

let currentEventTransitionLane: Lane = NoLane;

export function ensureRootIsScheduled(root: FiberRoot): void {
  // This function is called whenever a root receives an update. It does two
  // things 1) it ensures the root is in the root schedule, and 2) it ensures
  // there's a pending microtask to process the root schedule.
  //
  // Most of the actual scheduling logic does not happen until
  // `scheduleTaskForRootDuringMicrotask` runs.

  // 每当 fiberRoot 节点收到更新时，都会调用此函数。它做两件事：
  //    1）确保根节点在根调度中
  //    2）确保有一个待处理的微任务来处理根调度。
  // 大多数实际的调度逻辑直到 `scheduleTaskForRootDuringMicrotask` 运行时才会发生。 

  // Add the root to the schedule
  // 将 root 添加到调度中 
  if (root === lastScheduledRoot || root.next !== null) {
    // Fast path. This root is already scheduled.
    // 快速路径。此 root 已经被调度。 
  } else {
    // 将 root 加入根调度队列中
    if (lastScheduledRoot === null) {
      firstScheduledRoot = lastScheduledRoot = root;
    } else {
      lastScheduledRoot.next = root;
      lastScheduledRoot = root;
    }
  }

  // Any time a root received an update, we set this to true until the next time we process the schedule. 
  // If it's false, then we can quickly exit flushSync without consulting the schedule.
  // 每当一个根节点接收到一个更新，我们就将此字段设置为 true，直到下一次处理调度。 
  // 如果它是 false，那么我们可以快速退出 flushSync，而无需参考调度。
  mightHavePendingSyncWork = true;

  // At the end of the current event, go through each of the roots and ensure
  // there's a task scheduled for each one at the correct priority.
  // 在当前事件结束时，遍历每个 root 并确保为每个 root 以正确的优先级安排了调度任务。 
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // We're inside an `act` scope.
    if (!didScheduleMicrotask_act) {
      didScheduleMicrotask_act = true;
      scheduleImmediateTask(processRootScheduleInMicrotask);
    }
  } else {
    if (!didScheduleMicrotask) {
      didScheduleMicrotask = true;
      // 在浏览器的任务队列中推入一个回调，这个回调执行 Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb)
      // 首选 queueMicrotask API，Promise.resolve().then 次之，最差是 setTimeout
      // ImmediatePriority：scheduler 的最高优先级
      // cb 是 processRootScheduleInMicrotask，也是 task.callback
      scheduleImmediateTask(processRootScheduleInMicrotask);
    }
  }

  // enableDeferRootSchedulingToMicrotask = true，当前是非禁用状态
  if (!enableDeferRootSchedulingToMicrotask) {
    // While this flag is disabled, we schedule the render task immediately instead of waiting a microtask.
    // TODO: We need to land enableDeferRootSchedulingToMicrotask ASAP to unblock additional features we have planned.
    // 当此标志被禁用时，我们会立即安排渲染任务，而不是等待微任务。
    // 待办事项: 我们需要尽快实现 enableDeferRootSchedulingToMicrotask 以解锁我们计划的其他功能。 
    scheduleTaskForRootDuringMicrotask(root, now());
  }

  if (
    __DEV__ &&
    !disableLegacyMode &&
    ReactSharedInternals.isBatchingLegacy &&
    root.tag === LegacyRoot
  ) {
    // Special `act` case: Record whenever a legacy update is scheduled.
    ReactSharedInternals.didScheduleLegacyUpdate = true;
  }
}

export function flushSyncWorkOnAllRoots() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  flushSyncWorkAcrossRoots_impl(false);
}

export function flushSyncWorkOnLegacyRootsOnly() {
  // This is allowed to be called synchronously, but the caller should check
  // the execution context first.
  if (!disableLegacyMode) {
    flushSyncWorkAcrossRoots_impl(true);
  }
}

function flushSyncWorkAcrossRoots_impl(onlyLegacy: boolean) {
  if (isFlushingWork) {
    // Prevent reentrancy.
    // TODO: Is this overly defensive? The callers must check the execution
    // context first regardless.
    return;
  }

  if (!mightHavePendingSyncWork) {
    // Fast path. There's no sync work to do.
    return;
  }

  // There may or may not be synchronous work scheduled. Let's check.
  let didPerformSomeWork;
  isFlushingWork = true;
  do {
    didPerformSomeWork = false;
    let root = firstScheduledRoot;
    while (root !== null) {
      if (onlyLegacy && (disableLegacyMode || root.tag !== LegacyRoot)) {
        // Skip non-legacy roots.
      } else {
        const workInProgressRoot = getWorkInProgressRoot();
        const workInProgressRootRenderLanes =
          getWorkInProgressRootRenderLanes();
        const nextLanes = getNextLanes(
          root,
          root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
        );
        if (includesSyncLane(nextLanes)) {
          // This root has pending sync work. Flush it now.
          didPerformSomeWork = true;
          performSyncWorkOnRoot(root, nextLanes);
        }
      }
      root = root.next;
    }
  } while (didPerformSomeWork);
  isFlushingWork = false;
}

function processRootScheduleInMicrotask() {
  // This function is always called inside a microtask. It should never be
  // called synchronously.
  // 此函数总是在微任务内部被调用。它绝不应被同步调用。 
  // 注释似乎不太对，根上是从微任务中出来的，但其实微任务之后是通过 MessageChannel 触发的，到这里，本质是在宏任务中进行的
  didScheduleMicrotask = false;
  if (__DEV__) {
    didScheduleMicrotask_act = false;
  }

  // We'll recompute this as we iterate through all the roots and schedule them.
  // 我们在遍历所有的 roots 并且调度它们时将重新计算
  mightHavePendingSyncWork = false;

  const currentTime = now();

  let prev = null;
  let root = firstScheduledRoot;
  while (root !== null) {
    // 记录下个根节点（FiberRoot)
    const next = root.next;

    if (
      currentEventTransitionLane !== NoLane &&
      shouldAttemptEagerTransition()
    ) {
      // A transition was scheduled during an event, but we're going to try to
      // render it synchronously anyway. We do this during a popstate event to
      // preserve the scroll position of the previous page.
      // 在一个事件期间安排了一个过渡，但无论如何我们都将尝试同步渲染它。我们在 popstate 事件期间这样做是为了保留上一页的滚动位置。 
      upgradePendingLaneToSync(root, currentEventTransitionLane);
    }

    const nextLanes = scheduleTaskForRootDuringMicrotask(root, currentTime);
    if (nextLanes === NoLane) {
      // This root has no more pending work. Remove it from the schedule. To
      // guard against subtle reentrancy bugs, this microtask is the only place
      // we do this — you can add roots to the schedule whenever, but you can
      // only remove them here.
      // 此 root 不再有未完成的工作。将其从调度中删除。为了
      // 防范微妙的重入错误，此微任务是我们执行此操作的唯一位置
      // 您可以随时将 roots 添加到调度中，但只能在此处删除它们。 

      // Null this out so we know it's been removed from the schedule.
      // 将其置空，以便我们知道它已从调度中删除。 
      root.next = null;
      if (prev === null) {
        // This is the new head of the list
        // 这是列表新的头节点 
        firstScheduledRoot = next;
      } else {
        prev.next = next;
      }
      if (next === null) {
        // This is the new tail of the list
        // 这是列表新的尾节点
        lastScheduledRoot = prev;
      }
    } else {
      // This root still has work. Keep it in the list.
      // 此 root 仍有任务。将其保留在列表中。 
      prev = root;
      // 如果有同步任务，则做标记，表示可能有挂起的同步任务
      if (includesSyncLane(nextLanes)) {
        mightHavePendingSyncWork = true;
      }
    }
    root = next;
  }

  currentEventTransitionLane = NoLane;

  // At the end of the microtask, flush any pending synchronous work. This has
  // to come at the end, because it does actual rendering work that might throw.
  // 在微任务结束时，刷新任何挂起的同步工作。这必须在最后进行，因为它进行的实际渲染工作可能会抛出异常。 
  flushSyncWorkOnAllRoots();
}

function scheduleTaskForRootDuringMicrotask(
  root: FiberRoot,
  currentTime: number,
): Lane {
  // This function is always called inside a microtask, 
  // or at the very end of a rendering task right before we yield to the main thread. 
  // It should never be called synchronously.
  // 此函数始终在微任务内部被调用，或者在渲染任务的最后，就在我们向主线程让步之前。它永远不应被同步调用。
  //
  // TODO: Unless enableDeferRootSchedulingToMicrotask is off. We need to land that ASAP to unblock additional features we have planned.
  // 待办事项：除非 enableDeferRootSchedulingToMicrotask 关闭。我们需要尽快实现这一点，以解除我们计划的其他功能的阻塞。
  //
  // This function also never performs React work synchronously; 
  // it should only schedule work to be performed later, in a separate task or microtask.
  // 此函数也永远不会同步执行 React 工作；它应该只安排稍后在单独的任务或微任务中执行的工作。 

  // Check if any lanes are being starved by other work. If so, mark them as
  // expired so we know to work on those next.
  // 检查是否有任何优先级因其他任务而被饿死。如果有，将其标记为过期，以便我们知道接下来处理这些任务。 
  markStarvedLanesAsExpired(root, currentTime);

  // Determine the next lanes to work on, and their priority.
  // 确定接下来要处理的 lanes 及其优先级。 

  // 获取即将处理的 fiber tree
  debugger
  const workInProgressRoot = getWorkInProgressRoot();
  const workInProgressRootRenderLanes = getWorkInProgressRootRenderLanes();
  const nextLanes = getNextLanes(
    root,
    root === workInProgressRoot ? workInProgressRootRenderLanes : NoLanes,
  );

  const existingCallbackNode = root.callbackNode;
  if (
    // Check if there's nothing to work on
    // 检查是否没有要处理的内容 
    nextLanes === NoLanes ||
    // If this root is currently suspended and waiting for data to resolve, don't
    // schedule a task to render it. We'll either wait for a ping, or wait to
    // receive an update.
    // 如果此 root 当前处于挂起状态并等待数据解析，请勿安排任务来渲染它。我们要么等待一个 ping，要么等待接收更新。 
    //
    // Suspended render phase
    // 暂停渲染阶段 
    (root === workInProgressRoot && isWorkLoopSuspendedOnData()) ||
    // Suspended commit phase
    // 暂停提交阶段
    root.cancelPendingCommit !== null
  ) {
    // Fast path: There's nothing to work on.
    // 快速路径：没有什么可处理的。 
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackNode = null;
    root.callbackPriority = NoLane;
    return NoLane;
  }

  // Schedule a new callback in the host environment.
  // 在宿主环境中安排新的回调。 
  if (includesSyncLane(nextLanes)) {
    // Synchronous work is always flushed at the end of the microtask, so we
    // don't need to schedule an additional task.
    // 同步工作总是在微任务结束时刷新，所以我们不需要安排额外的任务。 
    if (existingCallbackNode !== null) {
      cancelCallback(existingCallbackNode);
    }
    root.callbackPriority = SyncLane;
    root.callbackNode = null;
    return SyncLane;
  } else {
    // We use the highest priority lane to represent the priority of the callback.
    // 我们使用最高优先级通道来表示回调的优先级。 
    const existingCallbackPriority = root.callbackPriority;
    // 从 lines 中获取优先级最高的一个
    const newCallbackPriority = getHighestPriorityLane(nextLanes);

    if (
      newCallbackPriority === existingCallbackPriority &&
      // Special case related to `act`. If the currently scheduled task is a
      // Scheduler task, rather than an `act` task, cancel it and re-schedule
      // on the `act` queue.
      // 与 `act` 相关的特殊情况。如果当前计划的任务是一个调度器任务，而不是 `act` 任务，则取消它并在 `act` 队列上重新安排 
      !(
        __DEV__ &&
        ReactSharedInternals.actQueue !== null &&
        existingCallbackNode !== fakeActCallbackNode
      )
    ) {
      // The priority hasn't changed. We can reuse the existing task.
      // 优先级未改变。我们可以复用现有的任务。 
      return newCallbackPriority;
    } else {
      // Cancel the existing callback. We'll schedule a new one below.
      // 取消现有的回调。我们将在下面安排一个新的。 
      cancelCallback(existingCallbackNode);
    }

    // 确定调度优先级
    let schedulerPriorityLevel;
    switch (lanesToEventPriority(nextLanes)) {
      case DiscreteEventPriority:
        schedulerPriorityLevel = ImmediateSchedulerPriority;
        break;
      case ContinuousEventPriority:
        schedulerPriorityLevel = UserBlockingSchedulerPriority;
        break;
      case DefaultEventPriority:
        schedulerPriorityLevel = NormalSchedulerPriority;
        break;
      case IdleEventPriority:
        schedulerPriorityLevel = IdleSchedulerPriority;
        break;
      default:
        schedulerPriorityLevel = NormalSchedulerPriority;
        break;
    }

    const newCallbackNode = scheduleCallback(
      schedulerPriorityLevel,
      performConcurrentWorkOnRoot.bind(null, root),
    );

    root.callbackPriority = newCallbackPriority;
    root.callbackNode = newCallbackNode;
    return newCallbackPriority;
  }
}

export type RenderTaskFn = (didTimeout: boolean) => RenderTaskFn | null;

export function getContinuationForRoot(
  root: FiberRoot,
  originalCallbackNode: mixed,
): RenderTaskFn | null {
  // This is called at the end of `performConcurrentWorkOnRoot` to determine
  // if we need to schedule a continuation task.
  //
  // Usually `scheduleTaskForRootDuringMicrotask` only runs inside a microtask;
  // however, since most of the logic for determining if we need a continuation
  // versus a new task is the same, we cheat a bit and call it here. This is
  // only safe to do because we know we're at the end of the browser task.
  // So although it's not an actual microtask, it might as well be.
  scheduleTaskForRootDuringMicrotask(root, now());
  if (root.callbackNode === originalCallbackNode) {
    // The task node scheduled for this root is the same one that's
    // currently executed. Need to return a continuation.
    return performConcurrentWorkOnRoot.bind(null, root);
  }
  return null;
}

const fakeActCallbackNode = {};

function scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: RenderTaskFn,
) {
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // Special case: We're inside an `act` scope (a testing utility).
    // Instead of scheduling work in the host environment, add it to a
    // fake internal queue that's managed by the `act` implementation.
    ReactSharedInternals.actQueue.push(callback);
    return fakeActCallbackNode;
  } else {
    return Scheduler_scheduleCallback(priorityLevel, callback);
  }
}

function cancelCallback(callbackNode: mixed) {
  if (__DEV__ && callbackNode === fakeActCallbackNode) {
    // Special `act` case: check if this is the fake callback node used by
    // the `act` implementation.
  } else if (callbackNode !== null) {
    Scheduler_cancelCallback(callbackNode);
  }
}

// 将回调通过 queueMicrotask 放入微任务队列
function scheduleImmediateTask(cb: () => mixed) {
  if (__DEV__ && ReactSharedInternals.actQueue !== null) {
    // Special case: Inside an `act` scope, we push microtasks to the fake `act`
    // callback queue. This is because we currently support calling `act`
    // without awaiting the result. The plan is to deprecate that, and require
    // that you always await the result so that the microtasks have a chance to
    // run. But it hasn't happened yet.
    ReactSharedInternals.actQueue.push(() => {
      cb();
      return null;
    });
  }

  // TODO: Can we land supportsMicrotasks? Which environments don't support it?
  // Alternatively, can we move this check to the host config?
  // TODO: 我们能否实现支持微任务？哪些环境不支持它？
  // 或者，我们能否将此检查移至主机配置？ 
  if (supportsMicrotasks) {
    scheduleMicrotask(() => {
      // In Safari, appending an iframe forces microtasks to run.
      // https://github.com/facebook/react/issues/22459
      // We don't support running callbacks in the middle of render
      // or commit so we need to check against that.
      // 在 Safari 中，添加 iframe 会强制运行微任务。
      // https://github.com/facebook/react/issues/22459
      // 我们不支持在渲染或提交过程中运行回调函数
      // 因此我们需要对此进行检查。 
      const executionContext = getExecutionContext();
      if ((executionContext & (RenderContext | CommitContext)) !== NoContext) {
        // Note that this would still prematurely flush the callbacks
        // if this happens outside render or commit phase (e.g. in an event).
        // 请注意，如果这发生在渲染或提交阶段之外（例如在事件中），这仍会过早刷新回调。

        // Intentionally using a macrotask instead of a microtask here. This is
        // wrong semantically but it prevents an infinite loop. The bug is
        // Safari's, not ours, so we just do our best to not crash even though
        // the behavior isn't completely correct.
        // 此处有意使用宏任务而不是微任务。从语义上讲这是错误的，但它可以防止无限循环。
        // 这个错误是 Safari 的，不是我们的，所以我们只是尽力做到即使行为不完全正确也不会崩溃。 
        Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb);
        return;
      }
      // 正常情况下走这儿
      cb();
    });
  } else {
    // If microtasks are not supported, use Scheduler.
    Scheduler_scheduleCallback(ImmediateSchedulerPriority, cb);
  }
}

export function requestTransitionLane(
  // This argument isn't used, it's only here to encourage the caller to
  // check that it's inside a transition before calling this function.
  // TODO: Make this non-nullable. Requires a tweak to useOptimistic.
  transition: BatchConfigTransition | null,
): Lane {
  // The algorithm for assigning an update to a lane should be stable for all
  // updates at the same priority within the same event. To do this, the
  // inputs to the algorithm must be the same.
  //
  // The trick we use is to cache the first of each of these inputs within an
  // event. Then reset the cached values once we can be sure the event is
  // over. Our heuristic for that is whenever we enter a concurrent work loop.
  if (currentEventTransitionLane === NoLane) {
    // All transitions within the same event are assigned the same lane.
    currentEventTransitionLane = claimNextTransitionLane();
  }
  return currentEventTransitionLane;
}

export function didCurrentEventScheduleTransition(): boolean {
  return currentEventTransitionLane !== NoLane;
}
