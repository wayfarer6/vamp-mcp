import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
from uuid import uuid4

from backends.library.registry import annotated_revision, register
from backends.library.steps import annotate_sections, sections
from backends.library.replay import load, replay, StepBlocked, OutcomeScreenBlocked


class ComposedSteps(TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / 'demo.py'
        self.source.write_text("import pyautogui as p\np.press('f2')\np.press('f3')\n")
        self.request = dict(title='Navigation', description='Open the inventory workspace', source_path=self.source,
                            backend='virtualbox', reviewed=True)
        self.step = dict(name='open', lines=[2, 2], entry='Home', exit='Menu')
        self.base = register(self.root, {**self.request, 'step_plan':[self.step]})
        self.ref = dict(name='open', use=dict(id=self.base['definition']['id'], commit=self.base['commit'], step='open'))
        self.local = dict(name='plant', lines=[3, 3], entry='Menu', exit='Plant')
        self.plan = [self.ref, self.local]

    def test_pins_an_immutable_reviewed_revision(self):
        self.source.write_text("import pyautogui as p\np.press('f4')\np.press('f3')\n")
        register(self.root,{**self.request,'id':self.ref['use']['id'],'step_plan':[self.step]})
        saved = register(self.root,{**self.request,'step_plan':self.plan})
        metadata, actions = load(dict(registry=self.root,id=saved['definition']['id'],vm_id=str(uuid4()),
                                      expected_commit=saved['commit'],inputs={},confirmed=True))
        self.assertEqual([a['keys'][0] for a in actions], ['f2','f3'])
        self.assertEqual(metadata['step_plan'],self.plan)
        self.assertEqual([a['enter_text'] for a in actions], ['Home','Menu'])

    def test_join_revision_and_key_boundaries(self):
        with self.assertRaisesRegex(ValueError,'preceding'):
            register(self.root,{**self.request,'step_plan':[self.ref,{**self.local,'entry':'Elsewhere'}]})
        unreviewed=register(self.root,{**self.request,'reviewed':False,'step_plan':[self.step]})
        use={**self.ref['use'],'id':unreviewed['definition']['id'],'commit':unreviewed['commit']}
        with self.assertRaisesRegex(ValueError,'reviewed'):
            register(self.root,{**self.request,'step_plan':[dict(name='open',use=use)]})
        self.source.write_text("import pyautogui as p\np.keyDown('shift')\np.press('a')\np.keyUp('shift')\n")
        with self.assertRaisesRegex(ValueError,'held key'):
            register(self.root,{**self.request,'step_plan':[self.local]})

    def test_failed_exit_stops_before_next_step(self):
        saved=register(self.root,{**self.request,'step_plan':self.plan})
        actions=json.loads((Path(saved['folder'])/'actions.json').read_text())
        driver=mock.Mock();driver.geometry.return_value=[1920,1080];driver.drain=mock.AsyncMock()
        checks=mock.AsyncMock(side_effect=[None,OutcomeScreenBlocked('Target missing')])
        progress={'verified_steps':[]}
        with mock.patch('backends.library.replay.verify_outcome_screen',checks):
            with self.assertRaises(StepBlocked) as failure:
                asyncio.run(replay(driver,actions,[1920,1080],step_progress=progress))
        driver.down.assert_called_once_with('f2')
        self.assertEqual((failure.exception.phase,failure.exception.completed),('exit_text',1))
        self.assertEqual(progress,{'verified_steps':[], 'current_step':'open'})

    def test_annotation_preserves_actions_and_moves_with_source(self):
        original = self.source.read_text()
        result = annotated_revision({**self.request, 'step_plan':self.plan, 'registry':self.root,
                                     'expected_commit':self.base['commit']})
        self.assertFalse(result['committed'])
        self.assertIn("# vamp-step: plant\np.press('f3')\n# vamp-end: plant", result['source'].replace('\r\n', '\n'))
        self.assertEqual(result['step_plan'][0], self.ref)
        self.assertEqual(self.source.read_text(), original)
        self.source.write_bytes(("# Extra context for the next editor\n" + result['source']).encode())
        saved = register(self.root,{**self.request,'step_plan':result['step_plan']})
        actions = json.loads((Path(saved['folder'])/'actions.json').read_text())
        self.assertEqual([a['keys'] for a in actions], [['f2'], ['f3']])
        self.assertEqual(annotate_sections(result['source'],result['step_plan']),
                         (result['source'],result['step_plan']))

    def test_marker_syntax_and_adjacent_ranges(self):
        source = "import pyautogui as p\r\np.press('f2')\r\np.press('f3')"
        marked, plan = annotate_sections(source,[self.step,self.local])
        self.assertEqual(sections(marked),{'open':[3,3],'plant':[6,6]})
        self.assertNotIn('\n',marked.replace('\r\n',''))
        self.assertEqual([s['section'] for s in plan], ['open','plant'])
        self.assertEqual(sections("msg = '''\n# vamp-step: ignored\n'''\n"), {})
        for source in ['# vamp-step: a', '# vamp-end: a',
                       '# vamp-step: a\n# vamp-step: b', 'x = 1 # vamp-step: bad']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                sections(source)

