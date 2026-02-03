interface MapFallbackProps {
  error?: Error | null;
}

function MapFallback({ error }: MapFallbackProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-gray-100 p-4 text-center dark:bg-gray-800" style={{ minHeight: '300px' }}>
      <p className="mb-2 text-lg font-semibold text-red-600 dark:text-red-400">
        Map could not be loaded.
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {error?.message || 'An unknown error occurred.'}
      </p>
      <p className="mt-2 text-xs text-gray-500">
         Verify that WebGL is enabled in your browser settings.
      </p>
    </div>
  );
}

export default MapFallback;
