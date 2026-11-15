import unittest
from vision import fuse


class FusionTests(unittest.TestCase):
    def test_label_belongs_to_smallest_containing_ui_region(self):
        detections = [
            {'xyxy':[0,0,400,200], 'center':[200,100], 'confidence':0.9},
            {'xyxy':[20,20,120,70], 'center':[70,45], 'confidence':0.8},
        ]
        lines = [
            {'text':'확인', 'language':'ko', 'confidence':0.97, 'xyxy':[40,30,100,60]},
            {'text':'Wrong', 'language':'en', 'confidence':0.55, 'xyxy':[40,30,100,60]},
            {'text':'outside', 'language':'en', 'confidence':0.99, 'xyxy':[500,30,580,60]},
        ]
        result = fuse(detections, lines)
        button = next(e for e in result if e['xyxy']==[20,20,120,70])
        self.assertEqual(button['text'], '확인')
        self.assertEqual(len(button['readings']), 2)
        outside = next(e for e in result if e['text']=='outside')
        self.assertEqual(outside['kind'], 'text')

    def test_repeated_labels_remain_distinct_click_candidates(self):
        lines = [{'text':'OK','language':'en','confidence':0.99,'xyxy':box}
                 for box in [[10,10,50,30],[100,100,140,120]]]
        result = fuse([], lines)
        self.assertEqual(len([e for e in result if e['text']=='OK']), 2)
        self.assertNotEqual(result[0]['id'], result[1]['id'])


if __name__ == '__main__':
    unittest.main()
