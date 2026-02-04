"""统一的异常类型定义"""


class RunningDataSyncError(Exception):
    """基础异常类"""

    pass


class SyncError(RunningDataSyncError):
    """同步相关错误（Strava/Garmin API）"""

    pass


class RateLimitError(SyncError):
    """API 速率限制错误"""

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class AuthenticationError(SyncError):
    """认证错误"""

    pass


class ParseError(RunningDataSyncError):
    """文件解析错误（GPX/TCX/FIT）"""

    pass


class StorageError(RunningDataSyncError):
    """数据存储错误（DuckDB）"""

    pass


class ConfigurationError(RunningDataSyncError):
    """配置错误"""

    pass
