import folder_paths
from server import PromptServer

from .exporter import register_routes


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

register_routes(
    PromptServer.instance.routes,
    folder_paths.get_output_directory,
    lambda prompt_id: PromptServer.instance.prompt_queue.get_history(prompt_id),
)
