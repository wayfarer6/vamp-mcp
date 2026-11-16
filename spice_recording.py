"""Robot listener recording the existing SPICE connection, never a second viewer."""
import json
from pathlib import Path
import subprocess
import time

_active = None


def sample(spice):
    if _active is not None and spice.surface:
        _active.sample(spice)


class RecordingListener:
    ROBOT_LISTENER_API_VERSION = 3

    def __init__(self, width=1920, height=1080, strict=False):
        self.width, self.height = int(width), int(height)
        self.strict = str(strict).lower() in ('true', '1', 'yes')
        self.output = None
        self.process = None
        self.frame = None
        self.frames = 0
        self.timeline = []
        self.dimensions = set()
        self.fps = 2

    def output_file(self, path):
        pass

    def start_test(self, data, result):
        global _active
        from robot.libraries.BuiltIn import BuiltIn
        self.output = Path(BuiltIn().get_variable_value('${OUTPUT DIR}'))
        self.output.mkdir(parents=True, exist_ok=True)
        self.slug = ''.join(c if c.isalnum() else '-' for c in data.name).strip('-').lower()
        self.started = time.monotonic()
        self.frames = 0
        self.frame = None
        self.process = None
        self.dimensions = set()
        self.timeline = [{'seconds': 0, 'event': 'test_start', 'name': data.name}]
        _active = self

    def start_keyword(self, data, result):
        if self.output is not None:
            self.timeline.append({'seconds': round(time.monotonic()-self.started, 3), 'event': 'keyword', 'name': data.name})

    def sample(self, spice):
        elapsed = time.monotonic() - self.started
        desired = int(elapsed*self.fps) + 1
        if desired <= self.frames:
            return
        image = spice._raw_image()
        self.dimensions.add(image.size)
        if self.strict and image.size != (self.width, self.height):
            raise AssertionError(f'Native recording needs {self.width}x{self.height}; guest is {image.size}')
        from PIL import Image
        # Changing boot resolutions are padded, never advertised as native QHD.
        canvas = Image.new('RGB', (self.width, self.height), '#101826')
        if image.width > canvas.width or image.height > canvas.height:
            image.thumbnail(canvas.size)
        canvas.paste(image, ((canvas.width-image.width)//2, (canvas.height-image.height)//2))
        current = canvas.tobytes()
        if self.process is None:
            import imageio_ffmpeg
            self.process = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', f'{self.width}x{self.height}', '-framerate', str(self.fps),
                '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', str(self.output/(self.slug+'.mp4'))], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        while self.frames < desired-1:
            self.process.stdin.write(self.frame or current)
            self.frames += 1
        self.process.stdin.write(current)
        self.frames += 1
        self.frame = current

    def end_test(self, data, result):
        global _active
        _active = None
        duration = time.monotonic()-self.started
        recording_error = None
        if self.process is not None:
            while self.frames < int(duration*self.fps)+1:
                self.process.stdin.write(self.frame)
                self.frames += 1
            self.process.stdin.close()
            error = self.process.stderr.read().decode()
            code = self.process.wait(timeout=60)
            if code:
                recording_error = error[-1000:]
                from robot.api import logger
                logger.error('SPICE video encoding failed: '+recording_error)
        self.timeline.append({'seconds': round(duration, 3), 'event': 'test_end', 'status': result.status})
        metadata = {'test': data.name, 'status': result.status, 'duration_seconds': duration,
                    'fps': self.fps, 'frames': self.frames, 'canvas': [self.width,self.height],
                    'guest_dimensions': sorted(self.dimensions), 'padded': any(d != (self.width, self.height) for d in self.dimensions), 'timeline': self.timeline,
                    'recording_error': recording_error}
        (self.output/(self.slug+'.json')).write_text(json.dumps(metadata, indent=2))
        self.output = None
