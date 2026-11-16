"""asyncvnc extension for RFB DesktopSize, needed across boot/display changes."""
import struct
import numpy as np
from asyncvnc import Video


class ResizableVideo(Video):
    async def read(self):
        x,y,width,height,encoding=struct.unpack('>HHHHi',await self.reader.readexactly(12))
        if encoding==-223:
            self.width,self.height=width,height
            self.data=None
            self.refresh()
            return
        if encoding==0:
            pixels=await self.reader.readexactly(height*width*4)
        elif encoding==6:
            length=int.from_bytes(await self.reader.readexactly(4),'big')
            pixels=self.decompress(await self.reader.readexactly(length))
        else:
            raise ValueError(f'Unsupported VNC encoding {encoding}')
        if x+width>self.width or y+height>self.height:
            raise ValueError('VNC update exceeds the framebuffer dimensions')
        if self.data is None:
            self.data=np.zeros((self.height,self.width,4),dtype='B')
        self.data[y:y+height,x:x+width]=np.frombuffer(pixels,dtype='B').reshape((height,width,4))
        self.data[y:y+height,x:x+width,self.mode.index('a')]=255


def enable_resize(client):
    client.video=ResizableVideo(**vars(client.video))
    encodings=[6,0,-223]
    client.writer.write(struct.pack('>BBH',2,0,len(encodings))+struct.pack('>'+('i'*len(encodings)),*encodings))
