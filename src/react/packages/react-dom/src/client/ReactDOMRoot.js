/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactNodeList, ReactFormState} from 'shared/ReactTypes';
import type {
  FiberRoot,
  TransitionTracingCallbacks,
} from 'react-reconciler/src/ReactInternalTypes';

import {isValidContainer} from 'react-dom-bindings/src/client/ReactDOMContainer';
import {queueExplicitHydrationTarget} from 'react-dom-bindings/src/events/ReactDOMEventReplaying';
import {REACT_ELEMENT_TYPE} from 'shared/ReactSymbols';
import {enableAsyncActions} from 'shared/ReactFeatureFlags';

export type RootType = {
  render(children: ReactNodeList): void,
  unmount(): void,
  _internalRoot: FiberRoot | null,
};

export type CreateRootOptions = {
  unstable_strictMode?: boolean,
  unstable_transitionCallbacks?: TransitionTracingCallbacks,
  identifierPrefix?: string,
  onUncaughtError?: (
    error: mixed,
    errorInfo: {+componentStack?: ?string},
  ) => void,
  onCaughtError?: (
    error: mixed,
    errorInfo: {
      +componentStack?: ?string,
      +errorBoundary?: ?React$Component<any, any>,
    },
  ) => void,
  onRecoverableError?: (
    error: mixed,
    errorInfo: {+componentStack?: ?string},
  ) => void,
};

export type HydrateRootOptions = {
  // Hydration options
  onHydrated?: (suspenseNode: Comment) => void,
  onDeleted?: (suspenseNode: Comment) => void,
  // Options for all roots
  unstable_strictMode?: boolean,
  unstable_transitionCallbacks?: TransitionTracingCallbacks,
  identifierPrefix?: string,
  onUncaughtError?: (
    error: mixed,
    errorInfo: {+componentStack?: ?string},
  ) => void,
  onCaughtError?: (
    error: mixed,
    errorInfo: {
      +componentStack?: ?string,
      +errorBoundary?: ?React$Component<any, any>,
    },
  ) => void,
  onRecoverableError?: (
    error: mixed,
    errorInfo: {+componentStack?: ?string},
  ) => void,
  formState?: ReactFormState<any, any> | null,
};

import {
  isContainerMarkedAsRoot,
  markContainerAsRoot,
  unmarkContainerAsRoot,
} from 'react-dom-bindings/src/client/ReactDOMComponentTree';
import {listenToAllSupportedEvents} from 'react-dom-bindings/src/events/DOMPluginEventSystem';
import {COMMENT_NODE} from 'react-dom-bindings/src/client/HTMLNodeType';

import {
  createContainer,
  createHydrationContainer,
  updateContainer,
  updateContainerSync,
  flushSyncWork,
  isAlreadyRendering,
  defaultOnUncaughtError,
  defaultOnCaughtError,
  defaultOnRecoverableError,
} from 'react-reconciler/src/ReactFiberReconciler';
import {ConcurrentRoot} from 'react-reconciler/src/ReactRootTags';

// $FlowFixMe[missing-this-annot]
function ReactDOMRoot(internalRoot: FiberRoot) {
  this._internalRoot = internalRoot;
}

// $FlowFixMe[prop-missing] found when upgrading Flow
ReactDOMHydrationRoot.prototype.render = ReactDOMRoot.prototype.render =
  // $FlowFixMe[missing-this-annot]
  /**
   * @param {*} children render 方法中的 JSX 对应的 VDOM
   */
  function (children: ReactNodeList): void {
    // FiberRoot 对象
    const root = this._internalRoot;

    if (root === null) {
      throw new Error('Cannot update an unmounted root.');
    }

    // 老版本 API 的参数检测，新版本的 render 方法只有一个参数
    if (__DEV__) {
      if (typeof arguments[1] === 'function') {
        console.error(
          'does not support the second callback argument. ' +
            'To execute a side effect after rendering, declare it in a component body with useEffect().',
        );
      } else if (isValidContainer(arguments[1])) {
        console.error(
          'You passed a container to the second argument of root.render(...). ' +
            "You don't need to pass it again since you already passed it to create the root.",
        );
      } else if (typeof arguments[1] !== 'undefined') {
        console.error(
          'You passed a second argument to root.render(...) but it only accepts ' +
            'one argument.',
        );
      }
    }
    // 确定 FiberRoot 的更新优先级，并处理其协调更新
    updateContainer(children, root, null, null);
  };

// $FlowFixMe[prop-missing] found when upgrading Flow
ReactDOMHydrationRoot.prototype.unmount = ReactDOMRoot.prototype.unmount =
  // $FlowFixMe[missing-this-annot]
  function (): void {
    if (__DEV__) {
      if (typeof arguments[0] === 'function') {
        console.error(
          'does not support a callback argument. ' +
            'To execute a side effect after rendering, declare it in a component body with useEffect().',
        );
      }
    }
    const root = this._internalRoot;
    if (root !== null) {
      this._internalRoot = null;
      const container = root.containerInfo;
      if (__DEV__) {
        if (isAlreadyRendering()) {
          console.error(
            'Attempted to synchronously unmount a root while React was already ' +
              'rendering. React cannot finish unmounting the root until the ' +
              'current render has completed, which may lead to a race condition.',
          );
        }
      }
      updateContainerSync(null, root, null, null);
      flushSyncWork();
      unmarkContainerAsRoot(container);
    }
  };

/**
 * 创建 reactDomRoot 对象 => { _internalRoot: rootFiber, render, unmount }
 *   1. 检测 DOM 元素是否有效 =》 是否是有效的 DOM 元素、当前 DOM 元素没有被重复使用
 *   2. 创建 React 应用的根节点 —— FiberRoot 对象，并创建应用的第一个 fiber 节点 —— RootFiber，并设置 fiberRoot.current = rootFiber。
 *      fiberRoot.current 表示当前屏幕上显示的 fiber 树，当然现阶段的 rootFiber 还是一个空的 fiber 节点
 *   3. React 事件委托机制
 *   4. 实例化 reactDomRoot 对象，并设置 this._internalRoot = rootFiber，对象上还有 render 和 unmount 方法
 */
export function createRoot(
  container: Element | Document | DocumentFragment,
  options?: CreateRootOptions,
): RootType {
  // 是否是有效的 DOM 元素
  if (!isValidContainer(container)) {
    throw new Error('Target container is not a DOM element.');
  }

  // 开发环境的警告信息，不允许重复使用同一个根节点，即多次在同一个 DOM 元素上创建 React 根节点
  warnIfReactDOMContainerInDEV(container);

  const concurrentUpdatesByDefaultOverride = false;
  let isStrictMode = false;
  let identifierPrefix = '';
  let onUncaughtError = defaultOnUncaughtError;
  let onCaughtError = defaultOnCaughtError;
  let onRecoverableError = defaultOnRecoverableError;
  let transitionCallbacks = null;

  // 处理 createRoot 方法的第二个参数，支持四个配置项，主要和异常相关，我们一般不用，不需要关注
  if (options !== null && options !== undefined) {
    if (__DEV__) {
      if ((options: any).hydrate) {
        console.warn(
          'hydrate through createRoot is deprecated. Use ReactDOMClient.hydrateRoot(container, <App />) instead.',
        );
      } else {
        if (
          typeof options === 'object' &&
          options !== null &&
          (options: any).$$typeof === REACT_ELEMENT_TYPE
        ) {
          console.error(
            'You passed a JSX element to createRoot. You probably meant to ' +
              'call root.render instead. ' +
              'Example usage:\n\n' +
              '  let root = createRoot(domContainer);\n' +
              '  root.render(<App />);',
          );
        }
      }
    }
    if (options.unstable_strictMode === true) {
      isStrictMode = true;
    }
    if (options.identifierPrefix !== undefined) {
      identifierPrefix = options.identifierPrefix;
    }
    if (options.onUncaughtError !== undefined) {
      onUncaughtError = options.onUncaughtError;
    }
    if (options.onCaughtError !== undefined) {
      onCaughtError = options.onCaughtError;
    }
    if (options.onRecoverableError !== undefined) {
      onRecoverableError = options.onRecoverableError;
    }
    if (options.unstable_transitionCallbacks !== undefined) {
      transitionCallbacks = options.unstable_transitionCallbacks;
    }
  }

  // 创建 FiberRoot（应用根节点），并设置 fiberRoot.current 设置为 rootRiber，作为屏幕上当前渲染的节点，但 rootFiber 目前还是一个空的 fiber 节点
  const root = createContainer(
    container,
    ConcurrentRoot,
    null,
    isStrictMode,
    concurrentUpdatesByDefaultOverride,
    identifierPrefix,
    onUncaughtError,
    onCaughtError,
    onRecoverableError,
    transitionCallbacks,
  );
  // 设置 root.current[key] = container，将当前容器节点标记为 React 的根 DOM 节点，和 warnIfReactDOMContainerInDEV 配套使用
  markContainerAsRoot(root.current, container);

  const rootContainerElement: Document | Element | DocumentFragment =
    container.nodeType === COMMENT_NODE
      ? (container.parentNode: any)
      : container;
  // React 事件委托机制
  listenToAllSupportedEvents(rootContainerElement);

  // $FlowFixMe[invalid-constructor] Flow no longer supports calling new on functions
  // 实例化 reactDomRoot 对象，并设置 this._internalRoot = rootFiber，对象上还有 render 和 unmount 方法
  return new ReactDOMRoot(root);
}

// $FlowFixMe[missing-this-annot]
function ReactDOMHydrationRoot(internalRoot: FiberRoot) {
  this._internalRoot = internalRoot;
}
function scheduleHydration(target: Node) {
  if (target) {
    queueExplicitHydrationTarget(target);
  }
}
// $FlowFixMe[prop-missing] found when upgrading Flow
ReactDOMHydrationRoot.prototype.unstable_scheduleHydration = scheduleHydration;

export function hydrateRoot(
  container: Document | Element,
  initialChildren: ReactNodeList,
  options?: HydrateRootOptions,
): RootType {
  if (!isValidContainer(container)) {
    throw new Error('Target container is not a DOM element.');
  }

  warnIfReactDOMContainerInDEV(container);

  if (__DEV__) {
    if (initialChildren === undefined) {
      console.error(
        'Must provide initial children as second argument to hydrateRoot. ' +
          'Example usage: hydrateRoot(domContainer, <App />)',
      );
    }
  }

  // For now we reuse the whole bag of options since they contain
  // the hydration callbacks.
  const hydrationCallbacks = options != null ? options : null;

  const concurrentUpdatesByDefaultOverride = false;
  let isStrictMode = false;
  let identifierPrefix = '';
  let onUncaughtError = defaultOnUncaughtError;
  let onCaughtError = defaultOnCaughtError;
  let onRecoverableError = defaultOnRecoverableError;
  let transitionCallbacks = null;
  let formState = null;
  if (options !== null && options !== undefined) {
    if (options.unstable_strictMode === true) {
      isStrictMode = true;
    }
    if (options.identifierPrefix !== undefined) {
      identifierPrefix = options.identifierPrefix;
    }
    if (options.onUncaughtError !== undefined) {
      onUncaughtError = options.onUncaughtError;
    }
    if (options.onCaughtError !== undefined) {
      onCaughtError = options.onCaughtError;
    }
    if (options.onRecoverableError !== undefined) {
      onRecoverableError = options.onRecoverableError;
    }
    if (options.unstable_transitionCallbacks !== undefined) {
      transitionCallbacks = options.unstable_transitionCallbacks;
    }
    if (enableAsyncActions) {
      if (options.formState !== undefined) {
        formState = options.formState;
      }
    }
  }

  const root = createHydrationContainer(
    initialChildren,
    null,
    container,
    ConcurrentRoot,
    hydrationCallbacks,
    isStrictMode,
    concurrentUpdatesByDefaultOverride,
    identifierPrefix,
    onUncaughtError,
    onCaughtError,
    onRecoverableError,
    transitionCallbacks,
    formState,
  );
  markContainerAsRoot(root.current, container);
  // This can't be a comment node since hydration doesn't work on comment nodes anyway.
  listenToAllSupportedEvents(container);

  // $FlowFixMe[invalid-constructor] Flow no longer supports calling new on functions
  return new ReactDOMHydrationRoot(root);
}

function warnIfReactDOMContainerInDEV(container: any) {
  if (__DEV__) {
    if (isContainerMarkedAsRoot(container)) {
      if (container._reactRootContainer) {
        console.error(
          'You are calling ReactDOMClient.createRoot() on a container that was previously ' +
            'passed to ReactDOM.render(). This is not supported.',
        );
      } else {
        console.error(
          'You are calling ReactDOMClient.createRoot() on a container that ' +
            'has already been passed to createRoot() before. Instead, call ' +
            'root.render() on the existing root instead if you want to update it.',
        );
      }
    }
  }
}
