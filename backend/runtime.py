"""偏好计算的页面会话暂停信号，不依赖模型库。"""


class PreferencePaused(RuntimeError):
    """在计算批次之间暂停，保留标注和已保存的模型。"""
