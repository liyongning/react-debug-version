/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from 'react-reconciler/src/ReactInternalTypes';
import type {ReactScopeInstance} from 'shared/ReactTypes';
import type {
  ReactDOMEventHandle,
  ReactDOMEventHandleListener,
} from './ReactDOMEventHandleTypes';
import type {
  Container,
  TextInstance,
  Instance,
  SuspenseInstance,
  Props,
  HoistableRoot,
  RootResources,
} from './ReactFiberConfigDOM';

import {
  HostComponent,
  HostHoistable,
  HostSingleton,
  HostText,
  HostRoot,
  SuspenseComponent,
} from 'react-reconciler/src/ReactWorkTags';

import {getParentSuspenseInstance} from './ReactFiberConfigDOM';

import {enableScopeAPI} from 'shared/ReactFeatureFlags';

const randomKey = Math.random().toString(36).slice(2);
const internalInstanceKey = '__reactFiber$' + randomKey;
const internalPropsKey = '__reactProps$' + randomKey;
const internalContainerInstanceKey = '__reactContainer$' + randomKey;
const internalEventHandlersKey = '__reactEvents$' + randomKey;
const internalEventHandlerListenersKey = '__reactListeners$' + randomKey;
const internalEventHandlesSetKey = '__reactHandles$' + randomKey;
const internalRootNodeResourcesKey = '__reactResources$' + randomKey;
const internalHoistableMarker = '__reactMarker$' + randomKey;

export function detachDeletedInstance(node: Instance): void {
  // TODO: This function is only called on host components. I don't think all of
  // these fields are relevant.
  delete (node: any)[internalInstanceKey];
  delete (node: any)[internalPropsKey];
  delete (node: any)[internalEventHandlersKey];
  delete (node: any)[internalEventHandlerListenersKey];
  delete (node: any)[internalEventHandlesSetKey];
}

export function precacheFiberNode(
  hostInst: Fiber,
  node: Instance | TextInstance | SuspenseInstance | ReactScopeInstance,
): void {
  (node: any)[internalInstanceKey] = hostInst;
}

export function markContainerAsRoot(hostRoot: Fiber, node: Container): void {
  // $FlowFixMe[prop-missing]
  node[internalContainerInstanceKey] = hostRoot;
}

export function unmarkContainerAsRoot(node: Container): void {
  // $FlowFixMe[prop-missing]
  node[internalContainerInstanceKey] = null;
}

export function isContainerMarkedAsRoot(node: Container): boolean {
  // $FlowFixMe[prop-missing]
  return !!node[internalContainerInstanceKey];
}

// Given a DOM node, return the closest HostComponent or HostText fiber ancestor.
// If the target node is part of a hydrated or not yet rendered subtree, then
// this may also return a SuspenseComponent or HostRoot to indicate that.
// Conceptually the HostRoot fiber is a child of the Container node. So if you
// pass the Container node as the targetNode, you will not actually get the
// HostRoot back. To get to the HostRoot, you need to pass a child of it.
// The same thing applies to Suspense boundaries.
// 给定一个 DOM 节点，返回最接近的 HostComponent 或 HostText Fiber 祖先。
// 如果目标节点是 hydrated 或尚未渲染子树的一部分，那么
// 这也可能返回一个 SuspenseComponent 或 HostRoot 以表明。
// 从概念上讲，HostRoot Fiber 是容器节点的子节点。因此，如果您
// 将容器节点作为目标节点传递，实际上您不会得到
// HostRoot 回来。要获取 HostRoot，您需要传递它的一个子节点。
// 同样的事情适用于 Suspense 边界。 
export function getClosestInstanceFromNode(targetNode: Node): null | Fiber {
  let targetInst = (targetNode: any)[internalInstanceKey];
  if (targetInst) {
    // Don't return HostRoot or SuspenseComponent here.
    return targetInst;
  }
  // If the direct event target isn't a React owned DOM node, we need to look
  // to see if one of its parents is a React owned DOM node.
  // 如果直接事件目标不是 React 拥有的 DOM 节点，我们需要查看
  // 其某个父节点是否为 React 拥有的 DOM 节点。 
  let parentNode = targetNode.parentNode;
  while (parentNode) {
    // We'll check if this is a container root that could include
    // React nodes in the future. We need to check this first because
    // if we're a child of a dehydrated container, we need to first
    // find that inner container before moving on to finding the parent
    // instance. Note that we don't check this field on  the targetNode
    // itself because the fibers are conceptually between the container
    // node and the first child. It isn't surrounding the container node.
    // If it's not a container, we check if it's an instance.
    // 我们将检查这是否是一个容器根，未来可能包含 React 节点。
    // 我们首先需要检查这一点，因为如果我们是 dehydrated 容器的子节点，
    // 我们需要首先找到那个内部容器，然后再继续寻找父实例。
    // 请注意，我们不在目标节点本身检查此字段，因为 fiber 在概念上位于容器节点和第一个子节点之间。
    // 它并不围绕容器节点。如果它不是一个容器，我们检查它是否是一个实例。 
    targetInst =
      (parentNode: any)[internalContainerInstanceKey] ||
      (parentNode: any)[internalInstanceKey];
    if (targetInst) {
      // Since this wasn't the direct target of the event, we might have
      // stepped past dehydrated DOM nodes to get here. However they could
      // also have been non-React nodes. We need to answer which one.

      // If we the instance doesn't have any children, then there can't be
      // a nested suspense boundary within it. So we can use this as a fast
      // bailout. Most of the time, when people add non-React children to
      // the tree, it is using a ref to a child-less DOM node.
      // Normally we'd only need to check one of the fibers because if it
      // has ever gone from having children to deleting them or vice versa
      // it would have deleted the dehydrated boundary nested inside already.
      // However, since the HostRoot starts out with an alternate it might
      // have one on the alternate so we need to check in case this was a
      // root.
      // 由于这并非事件的直接目标，我们可能已经
      // 跨过 dehydrated 的 DOM 节点来到这里。然而，它们也可能是
      // 非 React 节点。我们需要回答是哪一种。

      // 如果实例没有任何子节点，那么其中不可能存在
      // 嵌套的悬念边界。因此，我们可以将此作为快速退出条件。大多数时候，当人们向树中添加非 React 子节点时，
      // 它是使用对无子 DOM 节点的引用。
      // 通常我们只需要检查其中一个纤维，因为如果它曾经从有子节点变为删除它们，或者反之亦然，
      // 它已经删除了嵌套在内部的脱水边界。
      // 然而，由于 HostRoot 一开始就有一个备用节点，它可能在备用节点上有一个，所以我们需要检查以防这是一个根节点。 
      const alternate = targetInst.alternate;
      if (
        targetInst.child !== null ||
        (alternate !== null && alternate.child !== null)
      ) {
        // Next we need to figure out if the node that skipped past is
        // nested within a dehydrated boundary and if so, which one.
        // 接下来，我们需要弄清楚跳过的节点是否嵌套在 dehydrated 边界内，如果是，是哪一个。 
        let suspenseInstance = getParentSuspenseInstance(targetNode);
        while (suspenseInstance !== null) {
          // We found a suspense instance. That means that we haven't
          // hydrated it yet. Even though we leave the comments in the
          // DOM after hydrating, and there are boundaries in the DOM
          // that could already be hydrated, we wouldn't have found them
          // through this pass since if the target is hydrated it would
          // have had an internalInstanceKey on it.
          // Let's get the fiber associated with the SuspenseComponent
          // as the deepest instance.
          // $FlowFixMe[prop-missing]
          const targetSuspenseInst = suspenseInstance[internalInstanceKey];
          if (targetSuspenseInst) {
            return targetSuspenseInst;
          }
          // If we don't find a Fiber on the comment, it might be because
          // we haven't gotten to hydrate it yet. There might still be a
          // parent boundary that hasn't above this one so we need to find
          // the outer most that is known.
          suspenseInstance = getParentSuspenseInstance(suspenseInstance);
          // If we don't find one, then that should mean that the parent
          // host component also hasn't hydrated yet. We can return it
          // below since it will bail out on the isMounted check later.
        }
      }
      return targetInst;
    }
    targetNode = parentNode;
    parentNode = targetNode.parentNode;
  }
  return null;
}

/**
 * Given a DOM node, return the ReactDOMComponent or ReactDOMTextComponent
 * instance, or null if the node was not rendered by this React.
 */
export function getInstanceFromNode(node: Node): Fiber | null {
  const inst =
    (node: any)[internalInstanceKey] ||
    (node: any)[internalContainerInstanceKey];
  if (inst) {
    const tag = inst.tag;
    if (
      tag === HostComponent ||
      tag === HostText ||
      tag === SuspenseComponent ||
      tag === HostHoistable ||
      tag === HostSingleton ||
      tag === HostRoot
    ) {
      return inst;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * Given a ReactDOMComponent or ReactDOMTextComponent, return the corresponding
 * DOM node.
 */
export function getNodeFromInstance(inst: Fiber): Instance | TextInstance {
  const tag = inst.tag;
  if (
    tag === HostComponent ||
    tag === HostHoistable ||
    tag === HostSingleton ||
    tag === HostText
  ) {
    // In Fiber this, is just the state node right now. We assume it will be
    // a host component or host text.
    return inst.stateNode;
  }

  // Without this first invariant, passing a non-DOM-component triggers the next
  // invariant for a missing parent, which is super confusing.
  throw new Error('getNodeFromInstance: Invalid argument.');
}

export function getFiberCurrentPropsFromNode(
  node: Instance | TextInstance | SuspenseInstance,
): Props {
  return (node: any)[internalPropsKey] || null;
}

export function updateFiberProps(
  node: Instance | TextInstance | SuspenseInstance,
  props: Props,
): void {
  (node: any)[internalPropsKey] = props;
}

export function getEventListenerSet(node: EventTarget): Set<string> {
  let elementListenerSet = (node: any)[internalEventHandlersKey];
  if (elementListenerSet === undefined) {
    elementListenerSet = (node: any)[internalEventHandlersKey] = new Set();
  }
  return elementListenerSet;
}

export function getFiberFromScopeInstance(
  scope: ReactScopeInstance,
): null | Fiber {
  if (enableScopeAPI) {
    return (scope: any)[internalInstanceKey] || null;
  }
  return null;
}

export function setEventHandlerListeners(
  scope: EventTarget | ReactScopeInstance,
  listeners: Set<ReactDOMEventHandleListener>,
): void {
  (scope: any)[internalEventHandlerListenersKey] = listeners;
}

export function getEventHandlerListeners(
  scope: EventTarget | ReactScopeInstance,
): null | Set<ReactDOMEventHandleListener> {
  return (scope: any)[internalEventHandlerListenersKey] || null;
}

export function addEventHandleToTarget(
  target: EventTarget | ReactScopeInstance,
  eventHandle: ReactDOMEventHandle,
): void {
  let eventHandles = (target: any)[internalEventHandlesSetKey];
  if (eventHandles === undefined) {
    eventHandles = (target: any)[internalEventHandlesSetKey] = new Set();
  }
  eventHandles.add(eventHandle);
}

export function doesTargetHaveEventHandle(
  target: EventTarget | ReactScopeInstance,
  eventHandle: ReactDOMEventHandle,
): boolean {
  const eventHandles = (target: any)[internalEventHandlesSetKey];
  if (eventHandles === undefined) {
    return false;
  }
  return eventHandles.has(eventHandle);
}

export function getResourcesFromRoot(root: HoistableRoot): RootResources {
  let resources = (root: any)[internalRootNodeResourcesKey];
  if (!resources) {
    resources = (root: any)[internalRootNodeResourcesKey] = {
      hoistableStyles: new Map(),
      hoistableScripts: new Map(),
    };
  }
  return resources;
}

export function isMarkedHoistable(node: Node): boolean {
  return !!(node: any)[internalHoistableMarker];
}

export function markNodeAsHoistable(node: Node) {
  (node: any)[internalHoistableMarker] = true;
}

export function isOwnedInstance(node: Node): boolean {
  return !!(
    (node: any)[internalHoistableMarker] || (node: any)[internalInstanceKey]
  );
}
