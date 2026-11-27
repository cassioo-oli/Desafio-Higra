"""Regressões: parada não confirma falha nem comprova recuperação."""
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import health_rules as rules
from health_service import _public_alert


class IncidentLifecycle(unittest.TestCase):
    def setUp(self):
        self.start = datetime(2026, 8, 9, 10)
        self.alerts = []
        self.tracker = rules._Tracker('corrente_r', self.alerts, duration_minutes=15)

    def confirm(self):
        for minute in range(16):
            self.tracker.update(True, self.start + timedelta(minutes=minute))

    def test_repeated_readings_and_stop_keep_one_incident(self):
        self.confirm()
        self.tracker.pause(self.start + timedelta(minutes=16))
        for minute in range(900, 930):
            self.tracker.update(True, self.start + timedelta(minutes=minute))
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(rules._score([self.tracker.alert])[0], 94)

    def test_stop_cannot_complete_normalization(self):
        self.confirm()
        self.tracker.update(False, self.start + timedelta(minutes=16))
        self.tracker.pause(self.start + timedelta(minutes=17))
        self.tracker.update(False, self.start + timedelta(hours=12))
        self.assertTrue(self.tracker.active)
        for minute in range(1, 361):
            self.tracker.update(False, self.start + timedelta(hours=12, minutes=minute))
        self.assertFalse(self.tracker.active)

    def test_missing_readings_cannot_complete_normalization(self):
        self.confirm()
        self.tracker.update(False, self.start + timedelta(minutes=16))
        self.tracker.update(None, self.start + timedelta(minutes=17))
        self.tracker.update(False, self.start + timedelta(hours=12))
        self.assertTrue(self.tracker.active)

    def test_short_candidate_stays_unconfirmed(self):
        self.tracker.update(True, self.start)
        self.tracker.pause(self.start + timedelta(minutes=1))
        self.assertIsNone(self.alerts[0]['confirmado_em'])
        self.assertEqual(self.alerts[0]['pontos_descontados'], 0)

    def test_future_recovery_is_not_exposed_in_past_period(self):
        self.confirm()
        self.tracker.force_close(self.start + timedelta(days=3), 'Normalizado')
        past = _public_alert(self.alerts[0], '2026-08-10T23:59:59')
        self.assertIsNone(past['resolvido_em'])
        self.assertEqual(past['status'], 'confirmado')
        self.assertEqual(past['pontos_ativos'], 6)

    def test_zero_rotation_with_residual_flow_is_not_operation(self):
        raw = lambda rpm, current: {'Rotacao (rpm)': rpm, 'Vazao (m³/h)': 15,
                                    'CorrenteR (A)': current}
        baseline = [(datetime(2026, 8, 1) + timedelta(minutes=i), raw(1500, 100)) for i in range(30)]
        stopped = [(self.start + timedelta(minutes=i), raw(0, 200)) for i in range(90)]
        result = rules.analyze(baseline + stopped, baseline_start='2026-08-01', baseline_end='2026-08-01')
        self.assertEqual(result['alertas'], [])
        self.assertIsNone(result['snapshot_em'])
        self.assertEqual(result['operacao'], 'parada')


if __name__ == '__main__':
    unittest.main()
