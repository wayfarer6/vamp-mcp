"""US keyboard mappings shared by SPICE and VNC transports."""
SCANCODES = dict(zip('1234567890', range(2, 12)))
SCANCODES.update(dict(zip('qwertyuiop', range(16, 26))))
SCANCODES.update(dict(zip('asdfghjkl', range(30, 39))))
SCANCODES.update(dict(zip('zxcvbnm', range(44, 51))))
SCANCODES.update(enter=28, esc=1, tab=15, space=57, ctrl=29, alt=56,
                 shift=42, super=0x15b, backspace=14, f2=60, left=0x14b,
                 right=0x14d, up=0x148, down=0x150, delete=0x153,
                 **{'-':12, '=':13, '[':26, ']':27, ';':39, "'":40,
                    '`':41, '\\':43, ',':51, '.':52, '/':53, ' ':57, '\n':28})
SCANCODES.update({f'f{i}': 58+i for i in range(1,11)})
SCANCODES.update(f11=87, f12=88)
SHIFTED = dict(zip('!@#$%^&*()_+{}:"~|<>?', '1234567890-=[];\'`\\,./'))
