#!/usr/bin/env python3
"""
Analyze price logs to determine ideal COPYTRADE_PRICE_BUFFER value.

This script analyzes historical price movements to recommend an optimal buffer
value for the time-based second side buy trigger.

Price log format: timestamp,market,slug,yes_price,no_price,sum
Example: 2026-01-10T17:13:36.580Z,btc,btc-updown-15m-1768064400,0.9850,0.0150,1.0000
"""

import sys
import csv
from pathlib import Path
from collections import defaultdict
import statistics

def parse_price_log(log_file):
    """Parse price log file and extract price data."""
    prices_by_market = defaultdict(list)
    
    with open(log_file, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            
            try:
                parts = line.split(',')
                if len(parts) < 5:
                    continue
                
                timestamp = parts[0]
                market = parts[1]
                slug = parts[2]
                yes_price = float(parts[3])
                no_price = float(parts[4])
                
                # Store both YES and NO prices
                prices_by_market[market].append({
                    'timestamp': timestamp,
                    'slug': slug,
                    'yes': yes_price,
                    'no': no_price,
                })
            except (ValueError, IndexError) as e:
                # Skip malformed lines
                continue
    
    return prices_by_market

def calculate_price_movements(prices):
    """Calculate price movement statistics."""
    if len(prices) < 2:
        return None
    
    movements = []
    for i in range(1, len(prices)):
        try:
            prev_yes = prices[i-1]['yes']
            curr_yes = prices[i]['yes']
            prev_no = prices[i-1]['no']
            curr_no = prices[i]['no']
            
            # Skip invalid values
            if not all(isinstance(p, (int, float)) and not (p != p) for p in [prev_yes, curr_yes, prev_no, curr_no]):
                continue
            
            # Calculate absolute price changes
            yes_change = abs(curr_yes - prev_yes)
            no_change = abs(curr_no - prev_no)
            
            movements.extend([yes_change, no_change])
        except (TypeError, KeyError, ValueError):
            continue
    
    if not movements or len(movements) < 2:
        return None
    
    try:
        return {
            'mean': statistics.mean(movements),
            'median': statistics.median(movements),
            'stdev': statistics.stdev(movements),
            'min': min(movements),
            'max': max(movements),
            'p50': statistics.median(movements),
            'p75': statistics.quantiles(movements, n=4)[2] if len(movements) > 3 else max(movements),
            'p90': statistics.quantiles(movements, n=10)[8] if len(movements) > 9 else max(movements),
            'p95': statistics.quantiles(movements, n=20)[18] if len(movements) > 19 else max(movements),
        }
    except (statistics.StatisticsError, ValueError):
        return None

def analyze_price_ranges(prices, threshold=0.5):
    """Analyze how often prices stay within ranges around threshold."""
    if not prices:
        return None
    
    buffer_candidates = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10]
    range_stats = {}
    
    for buffer in buffer_candidates:
        lower_bound = threshold - buffer
        upper_bound = threshold
        
        in_range_count = 0
        total_count = 0
        consecutive_in_range = 0
        max_consecutive = 0
        
        for price_data in prices:
            yes_price = price_data['yes']
            no_price = price_data['no']
            
            # Check if either price is in range
            yes_in_range = lower_bound <= yes_price <= upper_bound
            no_in_range = lower_bound <= no_price <= upper_bound
            
            if yes_in_range or no_in_range:
                in_range_count += 1
                consecutive_in_range += 1
                max_consecutive = max(max_consecutive, consecutive_in_range)
            else:
                consecutive_in_range = 0
            
            total_count += 1
        
        range_stats[buffer] = {
            'in_range_percent': (in_range_count / total_count * 100) if total_count > 0 else 0,
            'max_consecutive': max_consecutive,
        }
    
    return range_stats

def recommend_buffer(movements_stats, range_stats):
    """Recommend optimal buffer based on analysis."""
    if not movements_stats or not range_stats:
        return 0.03  # Default fallback
    
    # Strategy: Use a buffer that captures ~75-90% of price movements
    # but isn't too wide (to avoid false triggers)
    
    median_movement = movements_stats.get('median', 0.02)
    p75_movement = movements_stats.get('p75', 0.03)
    p90_movement = movements_stats.get('p90', 0.05)
    
    # Recommended buffer should be:
    # 1. At least the median movement (captures 50% of movements)
    # 2. Preferably around p75-p90 (captures 75-90% of movements)
    # 3. But not too wide (max 0.05-0.06)
    
    # Start with p75 as base recommendation
    recommended = round(p75_movement, 2)
    
    # Clamp between reasonable bounds
    recommended = max(0.01, min(0.05, recommended))
    
    # Round to nearest 0.01 (1 cent)
    recommended = round(recommended, 2)
    
    return recommended

def main():
    log_dir = Path('logs')
    log_file = log_dir / 'price.log'
    
    if not log_file.exists():
        print(f"Error: Price log file not found: {log_file}", file=sys.stderr)
        sys.exit(1)
    
    print("Analyzing price logs...")
    print(f"Reading from: {log_file}")
    
    prices_by_market = parse_price_log(log_file)
    
    if not prices_by_market:
        print("Error: No price data found in log file", file=sys.stderr)
        sys.exit(1)
    
    print(f"\nFound {len(prices_by_market)} market(s)")
    for market, prices in prices_by_market.items():
        print(f"  {market}: {len(prices)} price points")
    
    # Analyze all prices combined
    all_prices = []
    for prices in prices_by_market.values():
        all_prices.extend(prices)
    
    print(f"\nTotal price points: {len(all_prices)}")
    
    # Calculate movement statistics
    print("\n" + "="*60)
    print("PRICE MOVEMENT ANALYSIS")
    print("="*60)
    movements_stats = calculate_price_movements(all_prices)
    
    if movements_stats:
        print(f"Mean movement:     {movements_stats['mean']:.4f}")
        print(f"Median movement:   {movements_stats['median']:.4f}")
        print(f"Std deviation:     {movements_stats['stdev']:.4f}")
        print(f"Min movement:      {movements_stats['min']:.4f}")
        print(f"Max movement:      {movements_stats['max']:.4f}")
        print(f"75th percentile:   {movements_stats['p75']:.4f}")
        print(f"90th percentile:   {movements_stats['p90']:.4f}")
        print(f"95th percentile:   {movements_stats['p95']:.4f}")
    else:
        print("Insufficient data for movement analysis")
    
    # Analyze price ranges (assuming threshold = 0.5 for binary markets)
    print("\n" + "="*60)
    print("PRICE RANGE ANALYSIS (for threshold = 0.5)")
    print("="*60)
    range_stats = analyze_price_ranges(all_prices, threshold=0.5)
    
    if range_stats:
        print(f"{'Buffer':<10} {'In Range %':<15} {'Max Consecutive':<20}")
        print("-" * 45)
        for buffer in sorted(range_stats.keys()):
            stats = range_stats[buffer]
            print(f"{buffer:<10.2f} {stats['in_range_percent']:>6.2f}%        {stats['max_consecutive']:<20}")
    else:
        print("Insufficient data for range analysis")
    
    # Recommend buffer
    print("\n" + "="*60)
    print("RECOMMENDATION")
    print("="*60)
    recommended = recommend_buffer(movements_stats, range_stats)
    print(f"\nRecommended COPYTRADE_PRICE_BUFFER: {recommended:.2f}")
    print(f"\nThis value:")
    print(f"  - Captures ~75% of typical price movements")
    print(f"  - Provides a reasonable range for time-based triggers")
    print(f"  - Balances sensitivity with false trigger prevention")
    
    if movements_stats:
        median = movements_stats['median']
        p90 = movements_stats['p90']
        print(f"\nAlternative considerations:")
        print(f"  - More conservative (median): {median:.2f} - captures 50% of movements")
        print(f"  - More aggressive (p90): {p90:.2f} - captures 90% of movements")
    
    print("\n" + "="*60)

if __name__ == '__main__':
    main()

