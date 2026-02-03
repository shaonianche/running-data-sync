import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class MapErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('MapErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center bg-gray-100 p-4 text-center dark:bg-gray-800" style={{ minHeight: '300px' }}>
          <p className="mb-2 text-lg font-semibold text-red-600 dark:text-red-400">
            Map could not be loaded.
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {this.state.error?.message || 'An unknown error occurred.'}
          </p>
          <p className="mt-2 text-xs text-gray-500">
             Verify that WebGL is enabled in your browser settings.
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}

export default MapErrorBoundary;
