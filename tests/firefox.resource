*** Keywords ***
Open Firefox Using Guest Keyboard
    Guest Hotkey    alt    f2
    Sleep    1s
    Guest Write    firefox
    Guest Hotkey    enter
    Sleep    5s
