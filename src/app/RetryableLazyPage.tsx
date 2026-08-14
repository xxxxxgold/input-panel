import {
  Component,
  createElement,
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode
} from "react";

import { WorkspaceLoadingState, type WorkspacePageLoadKind } from "./WorkspaceLoadingState";

export type LazyPageLoader<P extends object> = () => Promise<{ default: ComponentType<P> }>;

export type RetryableLazyPageProps<P extends object> = {
  page: WorkspacePageLoadKind;
  loader: LazyPageLoader<P>;
  componentProps?: P;
  props?: P;
  children?: ReactNode;
  render?: (LoadedPage: ComponentType<P>) => ReactNode;
};

type LazyPageRendererProps<P extends object> = {
  componentProps?: P;
  children?: ReactNode;
  render?: (LoadedPage: ComponentType<P>) => ReactNode;
};

type PageImportErrorBoundaryProps = {
  page: WorkspacePageLoadKind;
  onRetry: () => void;
  children: ReactNode;
};

type PageImportErrorBoundaryState = {
  error: unknown | null;
};

export function createRetryableLazyPage<P extends object>(
  loader: LazyPageLoader<P>
): LazyExoticComponent<ComponentType<LazyPageRendererProps<P>>> {
  return lazy(async () => {
    const { default: LoadedPage } = await loader();

    return {
      default: ({ componentProps, children, render }: LazyPageRendererProps<P>) => {
        if (render) {
          return render(LoadedPage);
        }

        return children === undefined
          ? createElement(LoadedPage, componentProps)
          : createElement(LoadedPage, componentProps, children);
      }
    };
  });
}

export function RetryableLazyPage<P extends object>({
  page,
  loader,
  componentProps,
  props,
  children,
  render
}: RetryableLazyPageProps<P>) {
  const [attempt, setAttempt] = useState(0);
  const LazyPage = useMemo(() => createRetryableLazyPage(loader), [attempt, loader]);
  const retry = useCallback(() => setAttempt((currentAttempt) => currentAttempt + 1), []);
  const resolvedComponentProps = componentProps ?? props;

  return (
    <PageImportErrorBoundary key={attempt} page={page} onRetry={retry}>
      <Suspense fallback={<WorkspaceLoadingState page={page} />}>
        {createElement(LazyPage, {
          componentProps: resolvedComponentProps,
          children,
          render
        })}
      </Suspense>
    </PageImportErrorBoundary>
  );
}

class PageImportErrorBoundary extends Component<PageImportErrorBoundaryProps, PageImportErrorBoundaryState> {
  state: PageImportErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): PageImportErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <WorkspaceLoadingState
          page={this.props.page}
          error={formatPageImportError(this.state.error)}
          onRetry={this.props.onRetry}
        />
      );
    }

    return this.props.children;
  }
}

function formatPageImportError(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "页面资源暂时不可用，请重新加载。";
}
