import contextlib
import io
import unittest
from unittest.mock import patch

import web_tool


class SearchTest(unittest.TestCase):
    def test_requested_query_count_and_result_fields(self):
        query = 'requested query with "quotes" and shell $(syntax)'
        with patch('sys.argv', ['web-tool', 'search', query, '2']), patch.object(web_tool, 'DDGS') as ddgs:
            ddgs.return_value.text.return_value = [dict(href='https://example.com', title='Title', body='Summary')]
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                web_tool.main()
            ddgs.return_value.text.assert_called_once_with(query, max_results=2)
            self.assertIn('URL: https://example.com\nTitle: Title\nSummary: Summary', output.getvalue())

    def test_default_result_count(self):
        with patch('sys.argv', ['web-tool', 'search', 'query']), patch.object(web_tool, 'DDGS') as ddgs:
            ddgs.return_value.text.return_value = []
            web_tool.main()
            ddgs.return_value.text.assert_called_once_with('query', max_results=5)

    def test_a_search_failure_exits_with_one_line_not_a_traceback(self):
        with patch('sys.argv', ['web-tool', 'search', 'query']), patch.object(web_tool, 'DDGS') as ddgs:
            ddgs.return_value.text.side_effect = RuntimeError('ddgs upstream is down')
            errors = io.StringIO()
            with contextlib.redirect_stderr(errors):
                with self.assertRaises(SystemExit) as caught:
                    web_tool.main()
            self.assertEqual(caught.exception.code, 1)
            self.assertIn('web search failed: ddgs upstream is down', errors.getvalue())
            self.assertNotIn('Traceback', errors.getvalue())


if __name__ == '__main__':
    unittest.main()
