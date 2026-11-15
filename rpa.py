#!/usr/bin/env python3
"""Small JSON command interface for AI-driven SPICE desktop control."""
import argparse
import json
from spice_robot import SpiceRobot


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--uri', default='spice://127.0.0.1:5900')
    sub = parser.add_subparsers(dest='command', required=True)
    capture = sub.add_parser('capture')
    capture.add_argument('--output', default='artifacts/guest.png')
    analyze = sub.add_parser('analyze')
    analyze.add_argument('--output', default='artifacts/ui.json')
    analyze.add_argument('--languages', default='ko,en,ja,zh')
    analyze.add_argument('--device', default='auto')
    click = sub.add_parser('click')
    click.add_argument('x', type=int)
    click.add_argument('y', type=int)
    text = sub.add_parser('click-text')
    text.add_argument('text')
    text.add_argument('--languages', default='ko,en,ja,zh')
    text.add_argument('--device', default='auto')
    login = sub.add_parser('login')
    credentials = login.add_mutually_exclusive_group()
    credentials.add_argument('--prompt-credentials', action='store_true')
    credentials.add_argument('--use-env', action='store_true')
    login.add_argument('--languages', default='en')
    login.add_argument('--device', default='auto')
    hotkey = sub.add_parser('hotkey')
    hotkey.add_argument('keys', nargs='+')
    write = sub.add_parser('write')
    write.add_argument('text')
    args = parser.parse_args()
    robot = SpiceRobot()
    try:
        info = robot.connect_spice(args.uri)
        if args.command == 'capture':
            result = {'path':robot.capture_guest_screen(args.output), **info}
        elif args.command == 'analyze':
            result = robot.analyze_guest_ui(args.output, args.languages, args.device)
        elif args.command == 'click-text':
            result = robot.click_guest_text(args.text, args.languages, args.device)
        elif args.command == 'login':
            from login_flow import read_credentials, fill_and_submit
            result = robot.prepare_naver_login(args.languages, args.device)
            if (args.prompt_credentials or args.use_env) and result['status'] == 'needs_credentials':
                username, password = read_credentials(args.prompt_credentials, robot)
                try:
                    result = fill_and_submit(robot, result, username, password)
                finally:
                    username = password = None
        elif args.command == 'click':
            robot.guest_click(args.x, args.y)
            result = {'clicked':[args.x,args.y]}
        elif args.command == 'hotkey':
            robot.guest_hotkey(*args.keys)
            result = {'pressed':args.keys}
        else:
            robot.guest_write(args.text)
            result = {'typed':args.text}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        robot.disconnect_spice()


if __name__ == '__main__':
    main()
